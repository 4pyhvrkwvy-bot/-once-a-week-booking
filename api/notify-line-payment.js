
// api/notify-line-payment.js
// Notify Once a Week Owner when a new Event payment proof is submitted.
// Uses native fetch. No Supabase SDK required.

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!supabaseUrl || !serviceKey || !lineToken) {
    return res.status(500).json({
      success: false,
      error: 'Server environment variables are incomplete'
    });
  }

  const baseUrl = supabaseUrl.replace(/\/+$/, '');

  const headers = {
    'Content-Type': 'application/json',
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`
  };

  async function db(path, options = {}) {
    const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) }
    });

    const body = await response.text();
    let data = null;

    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      throw new Error(`Supabase returned invalid JSON: ${body}`);
    }

    if (!response.ok) {
      throw new Error(`Supabase error ${response.status}: ${body}`);
    }

    return data;
  }

  try {
    const bookingId = String(req.body?.bookingId || '').trim();

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid booking ID'
      });
    }

    // Only notify for a booking with a submitted proof awaiting review.
    const bookings = await db(
      `event_bookings?select=id,booking_code,event_id,session_id,customer_name,customer_phone,party_size,total_amount,deposit_amount,payment_review_status,payment_submitted_at,payment_proof_path&id=eq.${bookingId}&payment_review_status=eq.pending_review`
    );

    const booking = bookings?.[0];

    if (!booking || !booking.payment_submitted_at || !booking.payment_proof_path) {
      return res.status(409).json({
        success: false,
        error: 'Booking is not awaiting payment review'
      });
    }

    const submittedAt = booking.payment_submitted_at;

    // Get event title.
    const events = await db(
      `events?select=id,title&id=eq.${booking.event_id}`
    );

    // Get session date and time.
    const sessions = await db(
      `event_sessions?select=id,session_date,start_time,end_time&id=eq.${booking.session_id}`
    );

    const event = events?.[0];
    const session = sessions?.[0];

    if (!event || !session) {
      throw new Error('Event or session information not found');
    }

    // Find the already-linked Owner LINE account.
    const admins = await db(
      'line_admin_users?select=line_user_id'
    );

    const userIds = [...new Set(
      (admins || []).map(x => x.line_user_id).filter(Boolean)
    )];

    if (!userIds.length) {
      throw new Error('No linked Owner LINE account found');
    }

    // Check whether this exact proof submission was already notified.
    const timestampFilter = encodeURIComponent(submittedAt);

    const oldLogs = await db(
      `line_notification_logs?select=id,status&booking_id=eq.${bookingId}&payment_submitted_at=eq.${timestampFilter}`
    );

    let logId;

    if (oldLogs?.length) {
      const oldLog = oldLogs[0];

      if (oldLog.status === 'sent' || oldLog.status === 'pending') {
        return res.status(200).json({
          success: true,
          duplicate: true
        });
      }

      // Retry only a previous failed notification.
      logId = oldLog.id;

      await db(
        `line_notification_logs?id=eq.${logId}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'pending',
            error_message: null
          })
        }
      );
    } else {
      const inserted = await db(
        'line_notification_logs',
        {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            booking_id: bookingId,
            payment_submitted_at: submittedAt,
            notification_type: 'payment_proof',
            status: 'pending'
          })
        }
      );

      logId = inserted?.[0]?.id;

      if (!logId) {
        return res.status(200).json({
          success: true,
          duplicate: true
        });
      }
    }

    const dateText = session.session_date || '-';
    const timeText =
      `${String(session.start_time || '').slice(0, 5)} - ` +
      `${String(session.end_time || '').slice(0, 5)}`;

    const money = value =>
      Number(value || 0).toLocaleString('th-TH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });

    const message = [
      'มีสลิปใหม่รอตรวจสอบ',
      '',
      `กิจกรรม: ${event.title}`,
      `Booking: ${booking.booking_code}`,
      `ลูกค้า: ${booking.customer_name}`,
      `เบอร์โทร: ${booking.customer_phone}`,
      `วันที่: ${dateText}`,
      `เวลา: ${timeText}`,
      `จำนวน: ${booking.party_size} คน`,
      `ยอดรวม: ${money(booking.total_amount)} บาท`,
      `มัดจำ: ${money(booking.deposit_amount)} บาท`,
      '',
      'กรุณาเปิด Staff Dashboard เพื่อดูสลิปและตรวจสอบการชำระเงิน'
    ].join('\n');

    // Push notification to the linked Owner LINE account(s).
    for (const userId of userIds) {
      const response = await fetch(
        'https://api.line.me/v2/bot/message/push',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${lineToken}`
          },
          body: JSON.stringify({
            to: userId,
            messages: [{ type: 'text', text: message }]
          })
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LINE push failed: ${errorText}`);
      }
    }

    await db(
      `line_notification_logs?id=eq.${logId}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'sent',
          sent_at: new Date().toISOString(),
          error_message: null
        })
      }
    );

    return res.status(200).json({
      success: true,
      notified: userIds.length
    });

  } catch (error) {
    console.error('LINE payment notification error:', error);

    return res.status(500).json({
      success: false,
      error: 'LINE notification failed',
      detail: error.message
    });
  }
};
