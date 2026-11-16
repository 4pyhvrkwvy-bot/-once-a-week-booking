// api/event-payment-proof.js
// POST /api/event-payment-proof
// Body: { path, token }

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const token = String(req.body?.token || '').trim();
    const path = String(req.body?.path || '').trim();

    if (!token || !path) {
      return res.status(400).json({
        error: 'กรุณาระบุ token และ path'
      });
    }

    // ตรวจสอบรูปแบบ path ที่มาจากการอัปโหลดสลิป
    const pathPattern =
      /^event-bookings\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._-]{1,120}$/i;

    if (!pathPattern.test(path)) {
      return res.status(400).json({
        error: 'รูปแบบ path ของสลิปไม่ถูกต้อง',
        detail: 'INVALID_PAYMENT_PROOF_PATH'
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({
        error: 'ไม่พบ SUPABASE_URL หรือ SUPABASE_SERVICE_ROLE_KEY ใน Vercel'
      });
    }

    // ตรวจสอบ URL ของ Supabase
    let baseUrl;

    try {
      baseUrl = new URL(supabaseUrl);
    } catch {
      return res.status(500).json({
        error: 'SUPABASE_URL ไม่ใช่ URL ที่ถูกต้อง'
      });
    }

    if (baseUrl.protocol !== 'https:') {
      return res.status(500).json({
        error: 'SUPABASE_URL ต้องใช้ HTTPS'
      });
    }

    const supabase = createClient(
      supabaseUrl,
      serviceKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    // ตรวจสอบสิทธิ์ Owner
    const {
      data: allowed,
      error: authError
    } = await supabase.rpc('staff_is_owner', {
      p_staff_token: token
    });

    if (authError) {
      console.error('Owner verification failed:', authError.message);

      return res.status(403).json({
        error: 'ตรวจสอบสิทธิ์ Owner ไม่สำเร็จ',
        detail: authError.message
      });
    }

    if (allowed !== true) {
      return res.status(403).json({
        error: 'บัญชีนี้ไม่มีสิทธิ์ตรวจสอบสลิป'
      });
    }

    // สร้าง Signed URL จาก Private Storage
    const {
      data,
      error: storageError
    } = await supabase.storage
      .from('booking-payment-proofs')
      .createSignedUrl(path, 120);

    if (storageError) {
      console.error('Create signed URL failed:', storageError.message);

      return res.status(500).json({
        error: 'สร้างลิงก์สลิปไม่สำเร็จ',
        detail: storageError.message
      });
    }

    if (!data?.signedUrl) {
      return res.status(500).json({
        error: 'Supabase ไม่ได้ส่ง Signed URL กลับมา'
      });
    }

    // แปลง URL ให้เป็น Absolute URL และตรวจสอบโดเมน
    let signedUrl;

    try {
      signedUrl = new URL(data.signedUrl, baseUrl.origin);

      if (signedUrl.origin !== baseUrl.origin) {
        throw new Error('Signed URL มีโดเมนไม่ตรงกับ Supabase');
      }

      if (signedUrl.protocol !== 'https:') {
        throw new Error('Signed URL ไม่ได้ใช้ HTTPS');
      }
    } catch (urlError) {
      console.error('Invalid signed URL:', urlError.message);

      return res.status(500).json({
        error: 'รูปแบบ Signed URL ไม่ถูกต้อง',
        detail: urlError.message
      });
    }

    return res.status(200).json({
      success: true,
      signedUrl: signedUrl.toString()
    });

  } catch (error) {
    console.error('Payment proof API error:', error);

    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดขณะเปิดสลิป',
      detail: error.message || 'Unknown error'
    });
  }
};
