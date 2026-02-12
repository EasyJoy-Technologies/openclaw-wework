const express = require('express');
const bodyParser = require('body-parser');
const xml2js = require('xml2js');
const fs = require('fs');
const { port, token, encodingAESKey, corpId } = require('./config');
const { crypt, verifySignature, decryptEcho, decryptMessage } = require('./wecom');
const { callOpenClaw } = require('./openclawClient');
const { getSession, setSession } = require('./sessionStore');
const { downloadMedia } = require('./media');
const { sendText } = require('./send');

const app = express();
const builder = new xml2js.Builder({ headless: true, cdata: true, rootName: 'xml' });

// --- Message Buffer State ---
// Key: userId, Value: { timer, messages: [], processing: bool }
const userBuffers = {};
const DEBOUNCE_MS = 1500; // Wait 1.5s to combine text+media

app.use(bodyParser.text({ type: '*/xml' }));

function buildTextReply(toUser, fromUser, content) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = Math.random().toString(36).slice(2, 10);
  const replyXml = builder.buildObject({
    ToUserName: toUser,
    FromUserName: fromUser,
    CreateTime: ts,
    MsgType: 'text',
    Content: content,
  });
  const encrypted = crypt.encrypt(replyXml);
  const sig = crypt.getSignature(ts.toString(), nonce, encrypted);
  const resp = builder.buildObject({
    Encrypt: encrypted,
    MsgSignature: sig,
    TimeStamp: ts,
    Nonce: nonce,
  });
  return resp;
}

function getSessionKey(userId) {
  let sessionKey = getSession(userId);
  if (!sessionKey) {
    sessionKey = `wecom:${userId}`;
    setSession(userId, sessionKey);
  }
  return sessionKey;
}

// Dedup cache: Set of MsgIds
const processedMsgIds = new Set();
setInterval(() => {
  if (processedMsgIds.size > 5000) processedMsgIds.clear();
}, 3600 * 1000);

app.get('/wecom/callback', (req, res) => {
  const { msg_signature: msgSignature, signature, timestamp, nonce, echostr } = req.query;
  const sig = msgSignature || signature;
  if (!echostr) return res.status(400).send('missing echostr');
  if (!sig || !timestamp || !nonce) return res.status(400).send('missing signature params');
  if (!verifySignature({ msgSignature: sig, timestamp, nonce, echostr })) return res.status(403).send('bad signature');
  let echoPlain = echostr;
  try { echoPlain = decryptEcho(echostr); } catch (_) {}
  res.type('text/plain').send(echoPlain);
});

app.post('/wecom/callback', async (req, res) => {
  const { msg_signature: msgSignature, signature, timestamp, nonce } = req.query;
  const sig = msgSignature || signature;
  const rawBody = req.body || '';
  if (!sig || !timestamp || !nonce) return res.status(400).send('missing signature params');
  if (!rawBody) return res.status(400).send('empty body');

  let encrypt;
  try {
    const parsed = await xml2js.parseStringPromise(rawBody, { explicitArray: false });
    encrypt = parsed?.xml?.Encrypt;
  } catch (e) {
    return res.status(400).send('invalid xml');
  }

  if (!encrypt) return res.status(400).send('missing Encrypt');

  const expected = crypt.getSignature(timestamp, nonce, encrypt);
  if (expected !== sig) return res.status(403).send('bad signature');

  let decryptedMsg;
  try {
    const msgXml = decryptMessage(encrypt);
    decryptedMsg = await xml2js.parseStringPromise(msgXml, { explicitArray: false });
    console.log('WeCom decrypted message:', decryptedMsg);
  } catch (e) {
    console.error('decrypt error', e);
    return res.status(500).send('decrypt error');
  }

  const msg = decryptedMsg?.xml;
  const fromUser = msg?.FromUserName;
  const toUser = msg?.ToUserName;
  if (!fromUser || !toUser) return res.type('text/plain').send('success');

  const userId = fromUser;
  const msgType = msg?.MsgType;
  const msgId = msg?.MsgId;

  // Dedup check
  if (msgId) {
    if (processedMsgIds.has(msgId)) {
      console.log(`Duplicate message ignored: ${msgId}`);
      return res.type('text/plain').send('success');
    }
    processedMsgIds.add(msgId);
  }

  // Ignore events
  if (msgType === 'event') {
    return res.type('text/plain').send('success');
  }

  // Init buffer for user if needed
  if (!userBuffers[userId]) {
    userBuffers[userId] = { timer: null, messages: [], processing: false };
  }
  const buffer = userBuffers[userId];

  // If buffer empty and not processing, send immediate Ack
  if (buffer.messages.length === 0 && !buffer.processing) {
    const ackReply = buildTextReply(fromUser, toUser, '已收到，稍后回复');
    res.type('application/xml').send(ackReply);
  } else {
    // Already buffered or processing previous batch, silence this one
    res.type('text/plain').send('success');
  }

  // Add message to buffer
  buffer.messages.push({ msg, type: msgType });

  // Reset debounce timer
  if (buffer.timer) clearTimeout(buffer.timer);
  
  buffer.timer = setTimeout(() => {
    processBatch(userId, fromUser);
  }, DEBOUNCE_MS);
});

async function processBatch(userId, fromUser) {
  const buffer = userBuffers[userId];
  if (!buffer || buffer.messages.length === 0) return;

  buffer.processing = true;
  const batch = [...buffer.messages];
  buffer.messages = []; // clear buffer for next batch
  buffer.timer = null;

  console.log(`Processing batch for ${userId}: ${batch.length} messages`);

  const sessionKey = getSessionKey(userId);
  let combinedPrompt = '';
  const tempFiles = [];

  // Sort: text first, then media? Or chronological?
  // Since we push in arrival order, chronological is best.
  // But we want to ensure text context is applied to image.
  
  for (const item of batch) {
    const m = item.msg;
    if (item.type === 'text') {
      combinedPrompt += `User Text: ${m.Content}\n\n`;
    } else if (['image', 'voice', 'audio', 'file'].includes(item.type)) {
      try {
        const mediaId = m.MediaId;
        const filePath = await downloadMedia(mediaId);
        tempFiles.push(filePath);
        combinedPrompt += `User File (${item.type}):\nMediaId: ${mediaId}\nLocalPath: ${filePath}\n`;
        if (m.PicUrl) combinedPrompt += `PicUrl: ${m.PicUrl}\n`;
        if (m.Recognition) combinedPrompt += `ASR: ${m.Recognition}\n`;
        combinedPrompt += '\n';
      } catch (e) {
        console.error('Media download failed', e);
        combinedPrompt += `[Media download failed: ${m.MediaId}]\n`;
      }
    }
  }

  if (tempFiles.length > 0) {
    combinedPrompt += `\nIMPORTANT: I have just downloaded ${tempFiles.length} file(s) to the local paths listed above. You MUST call the 'image' tool (or 'read' for text/audio) to inspect them. DO NOT apologize. DO NOT say you haven't seen them. Simply call the tool and wait for the content.`;
  }

  try {
    // Call assistant with combined prompt
    // Timeout 120s because batch might have multiple images
    const replyText = await callOpenClaw({ message: combinedPrompt, sessionKey, finishOnFirstText: false, timeoutMs: 120000 });
    
    // Filter apologies
    let finalText = replyText || '';
    const hallucinationPatterns = [
      /^(抱歉|对不起|Sorry).{0,50}(看|图片|上传|see|image|upload).*?(\n|$)/is
    ];
    for (const pattern of hallucinationPatterns) {
      if (pattern.test(finalText)) {
         const stripped = finalText.replace(pattern, '').trim();
         if (stripped.length > 20) {
           finalText = stripped;
         }
      }
    }

    if (finalText) {
      await sendText(fromUser, finalText);
      console.log('Batch reply sent');
    }
  } catch (err) {
    console.error('Batch processing error', err.message || err);
    try {
      await sendText(fromUser, '消息处理遇到问题，请稍后重试');
    } catch (_) {}
  } finally {
    // Cleanup temp files
    for (const fp of tempFiles) {
      if (fs.existsSync(fp)) fs.unlink(fp, () => {});
    }
    // Mark processing done
    // If new messages arrived during processing, buffer.messages is not empty,
    // but the timer isn't running? No, new messages set new timer.
    // So we just clear the flag.
    buffer.processing = false;
    
    // Clean up empty user entry?
    if (buffer.messages.length === 0 && !buffer.timer) {
      delete userBuffers[userId];
    }
  }
}

app.head('/wecom/callback', (_req, res) => res.status(200).end());
app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(port, '127.0.0.1', () => {
  console.log(`WeCom callback listening on 127.0.0.1:${port}`);
  console.log(`CorpID=${corpId}`);
  console.log(`Token=${token}`);
  console.log(`AES=${encodingAESKey.slice(0,4)}...`);
});
