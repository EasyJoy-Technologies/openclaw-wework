const { clawUrl, clawToken } = require('./config');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

/**
 * 调用 OpenClaw /v1/responses，支持多轮对话历史。
 *
 * @param {string} message        本次用户消息
 * @param {Array}  history        历史记录 [{role, content}]，最新的在末尾
 * @param {number} timeoutMs      超时毫秒数
 * @returns {Promise<string>}     AI 回复文本
 */
async function callOpenClaw({ message, history = [], timeoutMs = 120000 }) {
  if (!clawToken) throw new Error('CLAW_TOKEN missing');
  if (!clawUrl) throw new Error('CLAW_URL missing');

  // 构建多轮对话 input 数组
  const input = [];

  for (const item of history) {
    if (item.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: item.content }],
      });
    } else if (item.role === 'assistant') {
      input.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: item.content }],
      });
    }
  }

  // 追加本次消息
  input.push({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: message }],
  });

  const payload = {
    model: 'openclaw:main',
    input,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(clawUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clawToken}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenClaw ${res.status}: ${text}`);
  }

  const data = await res.json();
  return extractText(data);
}

/**
 * 从 /v1/responses 响应体中提取文本内容。
 */
function extractText(data) {
  if (!data) return '';

  // 标准格式：data.output = [{content: [{type:'output_text', text:'...'}]}]
  if (Array.isArray(data.output)) {
    const parts = [];
    for (const item of data.output) {
      if (typeof item === 'string') { parts.push(item); continue; }
      if (item?.content) {
        if (typeof item.content === 'string') {
          parts.push(item.content);
        } else if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (typeof c === 'string') parts.push(c);
            else if (c?.text) parts.push(c.text);
          }
        }
      }
      if (item?.text) parts.push(item.text);
    }
    const result = parts.filter(Boolean).join('\n');
    if (result) return result;
  }

  if (typeof data.output === 'string') return data.output;
  if (data.output?.content) {
    if (typeof data.output.content === 'string') return data.output.content;
    if (Array.isArray(data.output.content)) {
      return data.output.content
        .map(c => (typeof c === 'string' ? c : c?.text || ''))
        .filter(Boolean)
        .join('\n');
    }
  }

  return '';
}

module.exports = { callOpenClaw };
