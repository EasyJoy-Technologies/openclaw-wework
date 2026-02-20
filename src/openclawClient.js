const crypto = require('crypto');
const { gatewayUrl, gatewayToken } = require('./occonfig');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

function uuid() {
  return crypto.randomUUID();
}

async function callOpenClaw({ message, sessionKey, agentId = 'main', timeoutMs = 120000 }) {
  if (!gatewayToken) throw new Error('gateway token missing');
  if (!gatewayUrl) throw new Error('gateway url missing');

  // Derive responses endpoint from gatewayUrl base
  // normalize ws:// -> http://, wss:// -> https://, strip trailing /ws
  let base = gatewayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  base = base.replace(/\/ws$/i, '').replace(/\/$/, '');
  const url = `${base}/v1/responses`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    model: 'openai-codex/gpt-5.1-codex-max',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: message }
        ]
      }
    ],
    stream: false
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${gatewayToken}`
    },
    body: JSON.stringify(payload),
    signal: controller.signal
  });
  clearTimeout(t);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`responses ${res.status}: ${text}`);
  }
  const data = await res.json();
  let text = '';
  if (Array.isArray(data.output)) {
    const parts = [];
    for (const item of data.output) {
      if (typeof item === 'string') { parts.push(item); continue; }
      if (item?.content) {
        if (typeof item.content === 'string') parts.push(item.content);
        else if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (typeof c === 'string') parts.push(c);
            else if (c?.text) parts.push(c.text);
          }
        }
      }
      if (item?.text) parts.push(item.text);
    }
    text = parts.filter(Boolean).join('\n');
  } else if (typeof data.output === 'string') {
    text = data.output;
  } else if (data.output?.content) {
    if (typeof data.output.content === 'string') text = data.output.content;
    else if (Array.isArray(data.output.content)) {
      text = data.output.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).filter(Boolean).join('\n');
    }
  }
  return text || '';
}

module.exports = { callOpenClaw };
