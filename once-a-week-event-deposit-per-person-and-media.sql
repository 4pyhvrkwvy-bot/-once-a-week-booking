-- Once a Week: Event deposit proof + Owner review workflow

-- Event deposit is a manually entered amount per participant. No default is set.
alter table public.events add column if not exists deposit_per_person numeric(10,2);
alter table public.events drop constraint if exists events_deposit_per_person_check;
alter table public.events add constraint events_deposit_per_person_check
  check (deposit_per_person is null or deposit_per_person >= 0);

-- Run after the existing events/event_sessions/event_bookings tables and staff_is_owner(text) exist.
-- This migration does not alter the regular Perler booking flow.

-- Booking payment review metadata
alter table public.event_bookings
  add column if not exists payment_review_status text not null default 'not_submitted',
  add column if not exists payment_proof_path text,
  add column if not exists payment_submitted_at timestamptz,
  add column if not exists payment_reviewed_at timestamptz,
  add column if not exists payment_reviewed_by text,
  add column if not exists payment_rejection_reason text,
  add column if not exists payment_expires_at timestamptz;

alter table public.event_bookings
  drop constraint if exists event_bookings_payment_review_status_check;
alter table public.event_bookings
  add constraint event_bookings_payment_review_status_check
  check (payment_review_status in ('not_submitted','pending_review','approved','rejected'));

alter table public.event_bookings
  drop constraint if exists event_bookings_booking_status_check;
alter table public.event_bookings
  add constraint event_bookings_booking_status_check
  check (booking_status in ('pending_payment','confirmed','cancelled','completed'));

-- Private bucket for payment slips
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('booking-payment-proofs', 'booking-payment-proofs', false, 5242880,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public=false, file_size_limit=5242880,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','application/pdf'];

-- Customers may upload a proof only into the folder matching their event booking UUID.
drop policy if exists "Customer upload event payment proof" on storage.objects;
create policy "Customer upload event payment proof"
on storage.objects for insert to anon, authenticated
with check (
  bucket_id = 'booking-payment-proofs'
  and (storage.foldername(name))[2] ~* '^[0-9a-f-]{36}$'
);

-- No public read policy. Proof files remain private; Owner previews them through the Vercel API route.

-- Release seats for abandoned unpaid bookings after 30 minutes.
create or replace function public.expire_pending_event_bookings()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  with expired as (
    update public.event_bookings
       set booking_status='cancelled',
           payment_rejection_reason='หมดเวลาชำระมัดจำ',
           payment_review_status='rejected'
     where booking_status='pending_payment'
       and payment_expires_at is not null
       and payment_expires_at < now()
     returning session_id, party_size
  ), totals as (
    select session_id, sum(party_size)::integer as seats
    from expired group by session_id
  )
  update public.event_sessions s
     set booked_seats=greatest(0,s.booked_seats-t.seats)
    from totals t where s.id=t.session_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.expire_pending_event_bookings() from public;
grant execute on function public.expire_pending_event_bookings() to anon, authenticated;

create or replace function public.submit_event_payment_proof(
  p_booking_id uuid,
  p_booking_code text,
  p_proof_path text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_proof_path is null
     or split_part(p_proof_path, '/', 1) <> 'event-bookings'
     or split_part(p_proof_path, '/', 2) <> p_booking_id::text then
    raise exception 'INVALID_PAYMENT_PROOF_PATH';
  end if;

  update public.event_bookings
  set payment_proof_path = p_proof_path,
      payment_submitted_at = now(),
      payment_review_status = 'pending_review'
  where id = p_booking_id
    and booking_code = p_booking_code
    and booking_status = 'pending_payment'
    and payment_review_status in ('not_submitted','rejected')
    and (payment_expires_at is null or payment_expires_at > now());

  if not found then raise exception 'BOOKING_NOT_AVAILABLE_FOR_PROOF'; end if;
end;
$$;
revoke all on function public.submit_event_payment_proof(uuid,text,text) from public;
grant execute on function public.submit_event_payment_proof(uuid,text,text) to anon, authenticated;

create or replace function public.staff_event_pending_payments(p_staff_token text)
returns table (
  booking_id uuid, booking_code text, event_title text, customer_name text,
  customer_phone text, party_size integer, session_date date,
  start_time time, end_time time, total_amount numeric,
  deposit_amount numeric, proof_path text, submitted_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not coalesce(public.staff_is_owner(p_staff_token), false) then
    raise exception 'EVENT_OWNER_REQUIRED';
  end if;
  return query
  select b.id, b.booking_code, e.title, b.customer_name, b.customer_phone,
         b.party_size, s.session_date, s.start_time, s.end_time,
         b.total_amount, b.deposit_amount, b.payment_proof_path, b.payment_submitted_at
  from public.event_bookings b
  join public.events e on e.id=b.event_id
  join public.event_sessions s on s.id=b.session_id
  where b.payment_review_status='pending_review'
  order by b.payment_submitted_at asc;
end;
$$;

create or replace function public.staff_event_review_payment(
  p_staff_token text,
  p_booking_id uuid,
  p_decision text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_booking public.event_bookings%rowtype;
begin
  if not coalesce(public.staff_is_owner(p_staff_token), false) then
    raise exception 'EVENT_OWNER_REQUIRED';
  end if;
  if p_decision not in ('approve','reject') then raise exception 'INVALID_REVIEW_DECISION'; end if;
  select * into v_booking from public.event_bookings
  where id=p_booking_id and payment_review_status='pending_review'
  for update;
  if not found then raise exception 'PAYMENT_REVIEW_NOT_PENDING'; end if;

  if p_decision='approve' then
    update public.event_bookings
    set payment_review_status='approved', payment_status='deposit_paid',
        booking_status='confirmed', payment_reviewed_at=now(),
        payment_reviewed_by='owner'
    where id=p_booking_id;
  else
    update public.event_bookings
    set payment_review_status='rejected', booking_status='cancelled',
        payment_reviewed_at=now(), payment_reviewed_by='owner',
        payment_rejection_reason=coalesce(nullif(trim(p_reason),''),'กรุณาตรวจสอบและส่งสลิปใหม่')
    where id=p_booking_id;
    update public.event_sessions
    set booked_seats=greatest(0,booked_seats-v_booking.party_size)
    where id=v_booking.session_id;
  end if;
end;
$$;

revoke all on function public.staff_event_pending_payments(text) from public;
revoke all on function public.staff_event_review_payment(text,uuid,text,text) from public;
grant execute on function public.staff_event_pending_payments(text) to anon, authenticated;
grant execute on function public.staff_event_review_payment(text,uuid,text,text) to anon, authenticated;

-- Change future Event bookings to pending payment. Seat count is reserved atomically
-- by the existing create_event_booking RPC; it will only become Confirmed after Owner approval.
create or replace function public.create_event_booking(
  p_event_id uuid,
  p_session_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_party_size integer,
  p_notes text default ''
)
returns table (booking_id uuid, booking_code text, total_amount numeric, deposit_amount numeric, balance_amount numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events%rowtype;
  v_session public.event_sessions%rowtype;
  v_booking_id uuid;
  v_code text;
  v_total numeric(10,2);
  v_deposit numeric(10,2);
  v_balance numeric(10,2);
begin
  perform public.expire_pending_event_bookings();
  if coalesce(length(trim(p_customer_name)),0)<2 then raise exception 'กรุณาระบุชื่อผู้จอง'; end if;
  if coalesce(length(regexp_replace(p_customer_phone,'[^0-9]','','g')),0)<8 then raise exception 'กรุณาระบุเบอร์โทรศัพท์ให้ถูกต้อง'; end if;
  if p_party_size is null or p_party_size<1 or p_party_size>8 then raise exception 'จำนวนผู้เข้าร่วมต้องอยู่ระหว่าง 1-8 คน'; end if;
  select * into v_event from public.events where id=p_event_id and status='published';
  if not found then raise exception 'Event นี้ไม่ได้เปิดรับจอง'; end if;
  select * into v_session from public.event_sessions
   where id=p_session_id and event_id=p_event_id and status='open' for update;
  if not found then raise exception 'ไม่พบรอบเวลานี้หรือรอบถูกปิดแล้ว'; end if;
  if v_session.session_date<current_date then raise exception 'ไม่สามารถจองวันที่ผ่านมาแล้ว'; end if;
  if v_session.booked_seats+p_party_size>v_session.capacity then raise exception 'ที่นั่งไม่เพียงพอ กรุณาเลือกรอบอื่น'; end if;
  v_total:=round(v_event.price_per_person*p_party_size,2);
  if v_event.deposit_per_person is null or v_event.deposit_per_person < 0 or v_event.deposit_per_person > v_event.price_per_person then raise exception 'INVALID_EVENT_DEPOSIT_PER_PERSON'; end if;
  v_deposit:=round(v_event.deposit_per_person*p_party_size,2);
  if v_deposit>v_total then raise exception 'เงินมัดจำรวมต้องไม่เกินราคารวมของกิจกรรม'; end if;
  v_balance:=v_total-v_deposit;
  v_code:='OWE-'||to_char(now(),'YYMMDD')||'-'||lpad(nextval('public.event_booking_code_seq')::text,5,'0');
  update public.event_sessions set booked_seats=booked_seats+p_party_size where id=p_session_id;
  insert into public.event_bookings (
    booking_code,event_id,session_id,customer_name,customer_phone,party_size,notes,
    unit_price,total_amount,deposit_amount,balance_amount,payment_status,booking_status,payment_review_status
  ) values (
    v_code,p_event_id,p_session_id,trim(p_customer_name),trim(p_customer_phone),p_party_size,
    coalesce(trim(p_notes),''),v_event.price_per_person,v_total,v_deposit,v_balance,
    'deposit_pending','pending_payment','not_submitted'
  ) returning id into v_booking_id;
  update public.event_bookings set payment_expires_at=now()+interval '30 minutes' where id=v_booking_id;
  return query select v_booking_id,v_code,v_total,v_deposit,v_balance;
end;
$$;
revoke all on function public.create_event_booking(uuid,uuid,text,text,integer,text) from public;
grant execute on function public.create_event_booking(uuid,uuid,text,text,integer,text) to anon, authenticated;


-- Replace the old percentage-based Event save RPC.
drop function if exists public.staff_event_save(text,uuid,text,text,text,text,numeric,numeric,integer,text);
create or replace function public.staff_event_save(
  p_staff_token text,
  p_event_id uuid,
  p_slug text,
  p_title text,
  p_description text,
  p_cover_url text,
  p_price_per_person numeric,
  p_deposit_per_person numeric,
  p_duration_minutes integer,
  p_status text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if not coalesce(public.staff_is_owner(p_staff_token), false) then raise exception 'EVENT_OWNER_REQUIRED'; end if;
  if coalesce(trim(p_title),'')='' then raise exception 'EVENT_TITLE_REQUIRED'; end if;
  if coalesce(p_slug,'') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'INVALID_EVENT_SLUG'; end if;
  if p_price_per_person is null or p_price_per_person < 0
     or p_deposit_per_person is null or p_deposit_per_person < 0
     or p_deposit_per_person > p_price_per_person
     or p_duration_minutes is null or p_duration_minutes < 1 then
    raise exception 'INVALID_EVENT_PRICE_DEPOSIT_OR_DURATION';
  end if;
  if p_status not in ('draft','published','closed','archived') then raise exception 'INVALID_EVENT_STATUS'; end if;
  if p_event_id is null then
    insert into public.events(slug,title,description,cover_url,price_per_person,deposit_per_person,duration_minutes,status,updated_at)
    values(lower(trim(p_slug)),trim(p_title),coalesce(trim(p_description),''),nullif(trim(p_cover_url),''),p_price_per_person,p_deposit_per_person,p_duration_minutes,p_status,now())
    returning id into v_id;
  else
    update public.events set slug=lower(trim(p_slug)),title=trim(p_title),description=coalesce(trim(p_description),''),
      cover_url=nullif(trim(p_cover_url),''),price_per_person=p_price_per_person,deposit_per_person=p_deposit_per_person,
      duration_minutes=p_duration_minutes,status=p_status,updated_at=now()
    where id=p_event_id returning id into v_id;
    if v_id is null then raise exception 'EVENT_NOT_FOUND'; end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.staff_event_save(text,uuid,text,text,text,text,numeric,numeric,integer,text) from public;
grant execute on function public.staff_event_save(text,uuid,text,text,text,text,numeric,numeric,integer,text) to anon,authenticated;

-- Public read for customer-facing Event cover images; uploads are performed only by the Owner API.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('event-media','event-media',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=true,file_size_limit=5242880,allowed_mime_types=array['image/jpeg','image/png','image/webp'];
drop policy if exists "Public can view Event media" on storage.objects;
create policy "Public can view Event media" on storage.objects for select to anon,authenticated using(bucket_id='event-media');
