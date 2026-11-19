const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ success:false, error:'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({success:false,error:'Server configuration incomplete'});

  const bookingId = String(req.body?.bookingId || '').trim();
  const bookingCode = String(req.body?.bookingCode || '').trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(bookingId) || !/^OWE-[A-Z0-9-]{6,30}$/i.test(bookingCode)) return res.status(400).json({success:false,error:'Invalid booking details'});

  const base = supabaseUrl.replace(/\/+$/, '');
  const headers = { apikey:serviceKey, Authorization:`Bearer ${serviceKey}`, 'Content-Type':'application/json' };
  async function db(path, options={}) {
    const r=await fetch(`${base}/rest/v1/${path}`,{...options,headers:{...headers,...(options.headers||{})}});
    const t=await r.text(); let d=null; try{d=t?JSON.parse(t):null}catch{}
    if(!r.ok) throw new Error(`Database request failed (${r.status}): ${t}`);
    return d;
  }

  try {
    const rows=await db(`event_bookings?select=id,booking_code,booking_status&id=eq.${bookingId}&booking_code=eq.${encodeURIComponent(bookingCode)}`);
    const booking=rows?.[0];
    if(!booking) return res.status(404).json({success:false,error:'Booking not found'});
    if(booking.booking_status==='cancelled') return res.status(409).json({success:false,error:'Booking is cancelled'});

    const existing=await db(`line_customer_links?select=line_user_id&booking_id=eq.${bookingId}`);
    if(existing?.[0]?.line_user_id) {
      return res.status(200).json({success:true,alreadyLinked:true,addFriendUrl:'https://lin.ee/5h2ODqc'});
    }

    const token=crypto.randomBytes(18).toString('base64url');
    const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt=new Date(Date.now()+30*60*1000).toISOString();
    await db('line_customer_links?on_conflict=booking_id',{
      method:'POST',
      headers:{Prefer:'resolution=merge-duplicates,return=minimal'},
      body:JSON.stringify({booking_id:bookingId,token_hash:tokenHash,expires_at:expiresAt,line_user_id:null,linked_at:null})
    });
    return res.status(200).json({success:true,token,expiresAt,addFriendUrl:'https://lin.ee/5h2ODqc'});
  } catch(e) {
    console.error('Create LINE customer link failed:',e);
    return res.status(500).json({success:false,error:'Could not create LINE link'});
  }
};
