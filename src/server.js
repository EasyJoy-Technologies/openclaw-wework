const express = require('express');
const bodyParser = require('body-parser');
const xml2js = require('xml2js');
const fs = require('fs');
const { port, token, encodingAESKey, corpId } = require('./config');
const { crypt, verifySignature, decryptEcho, decryptMessage } = require('./wecom');
const { getHistory, appendHistory, clearHistory } = require('./sessionStore');
const { downloadMedia } = require('./media');
const { sendText } = require('./send');
const { callOpenClaw } = require('./openclawClient');

const app = express();
const builder = new xml2js.Builder({ headless: true, cdata: true, rootName: 'xml' });

// --- 用户消息合并缓冲（防止图片+文字拆成两条）---
// Key: userId, Value: { timer, messages: [], processing: bool }
const userBuffers = {};
const DEBOUNCE_MS = 1500;

app.use(bodyParser.text({ type: '*/xml' }));

// --- 特殊指令 ---
const CMD_CLEAR = ['清除记忆', '重置对话', '清空记录', '清空对话', '/clear', '/reset'];
const CMD_SUMMARY = ['帮我总结', '总结一下', '总结对话', '/summary'];

function detectCommand(text) {
  const t = text.trim();
  if (CMD_CLEAR.includes(t)) return 'clear';
  if (CMD_SUMMARY.includes(t)) return 'summary';
  return null;
}

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

// Dedup cache
const processedMsgIds = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, info] of processedMsgIds.entries()) {
    if (now - info.ts > 3600 * 1000) processedMsgIds.delete(id);
  }
}, 10 * 60 * 1000);

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

  // Dedup
  if (msgId) {
    const entry = processedMsgIds.get(msgId);
    if (entry?.state === 'done') {
      console.log(`Duplicate message ignored (done): ${msgId}`);
      return res.type('text/plain').send('success');
    }
    if (entry?.state === 'processing' && Date.now() - entry.ts < 5 * 60 * 1000) {
      console.log(`Duplicate message ignored (in-flight): ${msgId}`);
      return res.type('text/plain').send('success');
    }
  }

  // 忽略事件
  if (msgType === 'event') {
    return res.type('text/plain').send('success');
  }

  if (!userBuffers[userId]) {
    userBuffers[userId] = { timer: null, messages: [], processing: false };
  }
  const buffer = userBuffers[userId];

  if (buffer.messages.length === 0 && !buffer.processing) {
    const ackReply = buildTextReply(fromUser, toUser, '收到，稍等...');
    res.type('application/xml').send(ackReply);
  } else {
    res.type('text/plain').send('success');
  }

  buffer.messages.push({ msg, type: msgType });

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
  buffer.messages = [];
  buffer.timer = null;

  console.log(`Processing batch for ${userId}: ${batch.length} messages`);

  const batchMsgIds = batch.map(item => item.msg?.MsgId).filter(Boolean);
  for (const id of batchMsgIds) {
    processedMsgIds.set(id, { state: 'processing', ts: Date.now() });
  }

  const tempFiles = [];

  try {
    // 合并本次 batch 为一段用户输入
    let userInput = '';
    for (const item of batch) {
      const m = item.msg;
      if (item.type === 'text') {
        userInput += (userInput ? '\n' : '') + (m.Content || '');
      } else if (['image', 'voice', 'audio', 'file'].includes(item.type)) {
        try {
          const mediaId = m.MediaId;
          const filePath = await downloadMedia(mediaId);
          tempFiles.push(filePath);
          userInput += `\n[${item.type}文件已下载到: ${filePath}`;
          if (m.PicUrl) userInput += `, PicUrl: ${m.PicUrl}`;
          if (m.Recognition) userInput += `, 语音识别: ${m.Recognition}`;
          userInput += ']';
        } catch (e) {
          console.error('Media download failed', e);
          userInput += `\n[媒体下载失败: ${m.MediaId}]`;
        }
      }
    }

    userInput = userInput.trim();
    if (!userInput) {
      buffer.processing = false;
      return;
    }

    // --- 特殊指令处理 ---
    const cmd = detectCommand(userInput);

    if (cmd === 'clear') {
      clearHistory(userId);
      await sendText(fromUser, '✅ 对话记忆已清除，我们重新开始吧！');
      for (const id of batchMsgIds) processedMsgIds.set(id, { state: 'done', ts: Date.now() });
      buffer.processing = false;
      return;
    }

    if (cmd === 'summary') {
      const history = getHistory(userId);
      if (history.length === 0) {
        await sendText(fromUser, '当前没有对话记录可以总结。');
        for (const id of batchMsgIds) processedMsgIds.set(id, { state: 'done', ts: Date.now() });
        buffer.processing = false;
        return;
      }
      userInput = '请总结一下我们到目前为止的对话内容，分点列出主要讨论的问题和结论。';
    }

    // --- 载入历史，调用 AI ---
    const history = getHistory(userId);

    if (tempFiles.length > 0) {
      userInput += `\n\nIMPORTANT: 请调用 image/read 工具查看以上本地路径的文件，不要道歉或说没有看到。`;
    }

    const replyText = await callOpenClaw({ message: userInput, history, timeoutMs: 120000 });

    let finalText = (replyText || '').trim();

    // 过滤幻觉道歉
    if (finalText) {
      const hallucinationPattern = /^(抱歉|对不起|Sorry).{0,50}(看|图片|上传|see|image|upload).*?(\n|$)/is;
      const stripped = finalText.replace(hallucinationPattern, '').trim();
      if (stripped.length > 20) finalText = stripped;
    }

    if (finalText) {
      // 写入历史（本次用户消息 + AI 回复）
      appendHistory(userId, 'user', userInput);
      appendHistory(userId, 'assistant', finalText);

      await sendText(fromUser, finalText);
      console.log(`Reply sent to ${userId}`);
    }

    for (const id of batchMsgIds) {
      processedMsgIds.set(id, { state: 'done', ts: Date.now() });
    }
  } catch (err) {
    console.error('Batch processing error', err?.message || err);
    if (err?.stack) console.error(err.stack);
    if (err?.response?.data) console.error('Response data:', err.response.data);
    for (const id of batchMsgIds) processedMsgIds.delete(id);
    try {
      await sendText(fromUser, '消息处理遇到问题，请稍后重试');
    } catch (_) {}
  } finally {
    for (const fp of tempFiles) {
      if (fs.existsSync(fp)) fs.unlink(fp, () => {});
    }
    buffer.processing = false;
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
  console.log(`AES=${encodingAESKey.slice(0, 4)}...`);
});
