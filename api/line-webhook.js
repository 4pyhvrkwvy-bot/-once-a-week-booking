// LINE webhook: link owner accounts and customer bookings
const crypto = require('crypto');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(body, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  let received;
  try { received = Buffer.from(signature, 'base64'); } catch { return false; }
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function supabaseConfig() {
  const base = (process.env.SUPABASE_URL || '').replace(/\\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('Missing Supabase environment variables');
  return { base, key };
}

async function db(path, options = {}) {
  const { base, key } = supabaseConfig();
  const response = await fetch(`${base}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}): ${body}`);
  try { return body ? JSON.parse(body) : null; } catch { return null; }
}

async function saveAdminUser(userId) {
  await db('line_admin_users?on_conflict=line_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ line_user_id: userId })
  });
}

async function linkCustomer(token, userId) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = new Date().toISOString();
  const rows = await db(
    `line_customer_links?select=id,booking_id&token_hash=eq.${tokenHash}&expires_at=gt.${encodeURIComponent(now)}&line_user_id=is.null`
  );
  if (!rows?.length) return false;

  // Conditional update consumes the one-time token; only a still-valid token can link.
  const updated = await db(
    `line_customer_links?id=eq.${rows[0].id}&token_hash=eq.${tokenHash}&expires_at=gt.${encodeURIComponent(now)}&line_user_id=is.null`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        line_user_id: userId,
        linked_at: now,
        token_hash: null,
        expires_at: null
      })
    }
  );
  return Array.isArray(updated) && updated.length === 1;
}

async function replyToLine(replyToken, message) {
  if (!replyToken || !process.env.LINE_CHANNEL_ACCESS_TOKEN) return;
  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: message }] })
  });
  if (!response.ok) console.error('LINE reply failed:', await response.text());
}

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    if (!channelSecret) {
      return res.status(500).json({ success: false, message: 'Server configuration incomplete' });
    }

    const rawBody = await readRawBody(req);
    if (!verifySignature(rawBody, req.headers['x-line-signature'], channelSecret)) {
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const events = Array.isArray(payload.events) ? payload.events : [];

    for (const event of events) {
      if (event.type !== 'message' || event.message?.type !== 'text' || !event.source?.userId) continue;

      const message = event.message.text.trim();
      const userId = event.source.userId;
      const adminCode = process.env.LINE_ADMIN_LINK_CODE;

      // Keep the existing owner-link flow working.
      if (adminCode && message === `LINK ${adminCode}`) {
        await saveAdminUser(userId);
        await replyToLine(event.replyToken, 'เชื่อมต่อบัญชี Once a Week สำหรับเจ้าของร้านสำเร็จแล้วค่ะ');
        continue;
      }

      // Customer link: LINK followed by the one-time booking token.
      const match = message.match(/^LINK\\s+([A-Za-z0-9_-]{20,40})$/);
      if (!match) continue;

      const linked = await linkCustomer(match[1], userId);
      await replyToLine(
        event.replyToken,
        linked
          ? 'เชื่อมต่อ LINE กับการจอง Once a Week สำเร็จแล้วค่ะ คุณจะได้รับข้อความแจ้งผลการตรวจสอบมัดจำทาง LINE'
          : 'รหัสเชื่อมต่อไม่ถูกต้องหรือหมดอายุแล้วค่ะ กรุณากลับไปที่หน้าการจองเพื่อขอรหัสใหม่'
      );
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('LINE webhook error:', error.message);
    return res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
};

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
