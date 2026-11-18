module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST') return res.status(405).json({success:false,error:'Method not allowed'});
  const base=(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  const lineToken=process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if(!base||!key||!lineToken) return res.status(500).json({success:false,error:'Server configuration incomplete'});
  const headers={apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  async function db(path,options={}) {
    const r=await fetch(`${base}/rest/v1/${path}`,{...options,headers:{...headers,...(options.headers||{})}});
    const t=await r.text();let d=null;try{d=t?JSON.parse(t):null}catch{}
    if(!r.ok)throw new Error(`Supabase error ${r.status}: ${t}`);
    return d;
  }
  let logId=null;
  try {
    const bookingId=String(req.body?.bookingId||'').trim();
    const decision=String(req.body?.decision||'').trim();
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)||!['approve','reject'].includes(decision))
      return res.status(400).json({success:false,error:'Invalid request'});
    const rows=await db(`event_bookings?select=id,booking_code,event_id,session_id,customer_name,total_amount,deposit_amount,balance_amount,payment_review_status,payment_rejection_reason&id=eq.${bookingId}`);
    const b=rows?.[0];
    const expected=decision==='approve'?'approved':'rejected';
    if(!b||b.payment_review_status!==expected) return res.status(409).json({success:false,error:'Booking review state does not match notification'});
    const links=await db(`line_customer_links?select=line_user_id,linked_at&booking_id=eq.${bookingId}`);
    const userId=links?.[0]?.line_user_id;
    if(!userId) return res.status(200).json({success:true,notified:false,reason:'Customer has not linked LINE'});
    const type=decision==='approve'?'payment_approved':'payment_rejected';
    const old=await db(`line_notification_logs?select=id,status&booking_id=eq.${bookingId}&notification_type=eq.${type}&limit=1`);
    if(old?.[0]?.status==='sent'||old?.[0]?.status==='pending') return res.status(200).json({success:true,duplicate:true});
    if(old?.[0]?.id){
      logId=old[0].id;
      await db(`line_notification_logs?id=eq.${logId}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'pending',error_message:null})});
    } else {
      const inserted=await db('line_notification_logs',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({booking_id:bookingId,notification_type:type,status:'pending'})});
      logId=inserted?.[0]?.id;
      if(!logId) throw new Error('Could not create notification log');
    }
    const events=await db(`events?select=title&id=eq.${b.event_id}`);
    const sessions=await db(`event_sessions?select=session_date,start_time,end_time&id=eq.${b.session_id}`);
    const event=events?.[0],session=sessions?.[0];
    const money=v=>Number(v||0).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
    const date=session?.session_date||'-';
    const time=session?`${String(session.start_time||'').slice(0,5)}–${String(session.end_time||'').slice(0,5)} น.`:'-';
    const message=decision==='approve'
      ? ['Once a Week แจ้งยืนยันการจอง','',`สวัสดีค่ะ คุณ${b.customer_name}`,'ตรวจสอบการชำระเงินเรียบร้อยแล้ว และยืนยันการจองของคุณแล้วค่ะ','',`กิจกรรม: ${event?.title||'-'}`,`Booking Code: ${b.booking_code}`,`วันที่: ${date}`,`เวลา: ${time}`,`ยอดรวม: ${money(b.total_amount)} บาท`,`ชำระมัดจำแล้ว: ${money(b.deposit_amount)} บาท`,`ยอดคงเหลือ: ${money(b.balance_amount)} บาท`,'','ขอบคุณที่เลือกใช้บริการ Once a Week ค่ะ'].join('\n')
      : ['Once a Week แจ้งผลการตรวจสอบสลิป','',`สวัสดีค่ะ คุณ${b.customer_name}`,'ขอแจ้งว่ายังไม่สามารถอนุมัติหลักฐานการชำระเงินของคุณได้ค่ะ',`Booking Code: ${b.booking_code}`,`เหตุผล: ${b.payment_rejection_reason||'กรุณาติดต่อร้านเพื่อสอบถามรายละเอียด'}`,'','กรุณาติดต่อร้านก่อนดำเนินการชำระเงินอีกครั้งค่ะ'].join('\n');
    const sent=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${lineToken}`},body:JSON.stringify({to:userId,messages:[{type:'text',text:message}]})});
    const sentText=await sent.text();
    if(!sent.ok) throw new Error(`LINE push failed (${sent.status}): ${sentText}`);
    await db(`line_notification_logs?id=eq.${logId}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'sent',sent_at:new Date().toISOString(),error_message:null})});
    return res.status(200).json({success:true,notified:true,bookingCode:b.booking_code});
  } catch(e) {
    console.error('LINE booking review notification failed:',e);
    if(logId) try{await db(`line_notification_logs?id=eq.${logId}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'failed',error_message:String(e.message||'Unknown error').slice(0,1000)})})}catch{}
    return res.status(500).json({success:false,error:'LINE notification failed'});
  }
};
