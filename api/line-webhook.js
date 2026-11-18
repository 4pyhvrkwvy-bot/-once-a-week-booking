// Refresh deployment with updated LINE credentials
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

  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest();

  let received;

  try {
    received = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }

  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)
  );
}

async function saveAdminUser(userId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error('Missing Supabase environment variables');
  }

  const response = await fetch(
    `${supabaseUrl}/rest/v1/line_admin_users?on_conflict=line_user_id`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        line_user_id: userId
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase save failed: ${errorText}`);
  }
}

async function replyToLine(replyToken, message) {
  if (!replyToken || !process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return;
  }

  const response = await fetch(
    'https://api.line.me/v2/bot/message/reply',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization':
          `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: 'text',
            text: message
          }
        ]
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('LINE reply failed:', errorText);
  }
}

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Method not allowed'
    });
  }

  try {
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    const adminLinkCode = process.env.LINE_ADMIN_LINK_CODE;

    if (!channelSecret || !adminLinkCode) {
      console.error('Missing LINE environment variables');

      return res.status(500).json({
        success: false,
        message: 'Server configuration incomplete'
      });
    }

    const rawBody = await readRawBody(req);
    const signature = req.headers['x-line-signature'];

    if (!verifySignature(rawBody, signature, channelSecret)) {
      return res.status(401).json({
        success: false,
        message: 'Invalid signature'
      });
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const events = Array.isArray(payload.events)
      ? payload.events
      : [];

    for (const event of events) {
      if (
        event.type !== 'message' ||
        event.message?.type !== 'text' ||
        !event.source?.userId
      ) {
        continue;
      }

      const text = event.message.text.trim();
      const expectedMessage = `LINK ${adminLinkCode}`;

      if (text !== expectedMessage) {
        continue;
      }

      await saveAdminUser(event.source.userId);

      await replyToLine(
        event.replyToken,
        'เชื่อมต่อบัญชี Once a Week สำเร็จแล้ว คุณจะได้รับการแจ้งเตือนจากระบบ'
      );
    }

    return res.status(200).json({
      success: true
    });

   } catch (error) {
    console.error('LINE webhook error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Webhook processing failed'
    });
  }
};

module.exports = handler;

module.exports.config = {
  api: {
    bodyParser: false
  }
};
