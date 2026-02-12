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

// Track active processing count per user
const userProcessingCounts = {};
// Dedup cache: Set of MsgIds
const processedMsgIds = new Set();
// Clean up old IDs every hour
setInterval(() => {
  if (processedMsgIds.size > 5000) processedMsgIds.clear();
}, 3600 * 1000);

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
  const sessionKey = getSessionKey(userId);
  const msgType = msg?.MsgType;
  const msgId = msg?.MsgId;

  // Dedup check
  if (msgId && processedMsgIds.has(msgId)) {
    console.log(`Duplicate message ignored: ${msgId}`);
    return res.type('text/plain').send('success');
  }
  if (msgId) processedMsgIds.add(msgId);

  // Ignore events (like enter_agent) to prevent spammy replies
  if (msgType === 'event') {
    return res.type('text/plain').send('success');
  }

  // Handle Ack logic based on processing state
  const currentCount = userProcessingCounts[userId] || 0;
  if (currentCount > 0) {
    res.type('text/plain').send('success');
  } else {
    const ackReply = buildTextReply(fromUser, toUser, '已收到，稍后回复');
    res.type('application/xml').send(ackReply);
  }

  // Increment active count
  userProcessingCounts[userId] = currentCount + 1;

  // Async handling
  (async () => {
    try {
      if (msgType === 'text') {
        const content = Array.isArray(msg.Content) ? msg.Content.join('') : msg.Content;
        let replyText = '';
        try {
          replyText = await callOpenClaw({ message: content, sessionKey, finishOnFirstText: false, timeoutMs: 60000 });
        } catch (err) {
          console.error('openclaw error (text async)', err.message || err);
        }
        try {
          await sendText(fromUser, replyText || '助手暂时不可用，请稍后重试');
          console.log('assistant text reply sent');
        } catch (e2) {
          console.error('sendText error (text)', e2.message || e2);
        }
        return;
      }

      if (msgType === 'image' || msgType === 'voice' || msgType === 'audio' || msgType === 'file') {
        const mediaId = msg.MediaId || msg.MediaID || '';
        const picUrl = msg.PicUrl || '';
        const format = msg.Format || '';
        const recognition = msg.Recognition || '';
        const title = msg.Title || '';
        const description = msg.Description || '';
        const fileExt = msg.FileExt || ''; 

        let filePath = null;
        try {
          filePath = await downloadMedia(mediaId);
          let desc = `WeCom ${msgType} message received.\nMediaId: ${mediaId}\nLocalPath: ${filePath}`;
          if (picUrl) desc += `\nPicUrl: ${picUrl}`;
          if (format) desc += `\nFormat: ${format}`;
          if (recognition) desc += `\nASR: ${recognition}`;
          if (title) desc += `\nTitle: ${title}`;
          if (description) desc += `\nDescription: ${description}`;
          if (fileExt) desc += `\nFileExt: ${fileExt}`;
          
          desc += `\n\nIMPORTANT: You must use the 'image' tool (or 'read' for text/audio files) to inspect the file at 'LocalPath'. I have just downloaded it for you. It takes a moment to read. Please WAIT for the tool output before saying you can't see it. Do not guess.`;

          const replyText = await callOpenClaw({ message: desc, sessionKey, finishOnFirstText: false, timeoutMs: 120000 });
          if (replyText) {
            await sendText(fromUser, replyText);
            console.log('assistant media reply sent');
          }
        } catch (err) {
          console.error('media async error', err.message || err);
          try {
            await sendText(fromUser, '已收到你的文件，但处理失败，请稍后重试');
            console.log('fallback media sendText sent');
          } catch (e2) {
            console.error('fallback sendText error', e2.message || e2);
          }
        } finally {
          // Cleanup temp file
          if (filePath && fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
              if (err) console.error('cleanup failed for', filePath, err);
              else console.log('cleaned up', filePath);
            });
          }
        }
        return;
      }
    } finally {
      // Decrement active count
      if (userProcessingCounts[userId]) {
        userProcessingCounts[userId]--;
        if (userProcessingCounts[userId] <= 0) {
          delete userProcessingCounts[userId];
        }
      }
    }
  })();
});

app.head('/wecom/callback', (_req, res) => res.status(200).end());
app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(port, '127.0.0.1', () => {
  console.log(`WeCom callback listening on 127.0.0.1:${port}`);
  console.log(`CorpID=${corpId}`);
  console.log(`Token=${token}`);
  console.log(`AES=${encodingAESKey.slice(0,4)}...`);
});
