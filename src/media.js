const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { corpId, agentSecret, agentId } = require('./config');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

let cachedToken = null;
let cachedExpire = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpire) return cachedToken;
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${agentSecret}`;
  const res = await axios.get(url);
  if (res.data.errcode !== 0) throw new Error(`gettoken failed: ${res.data.errmsg}`);
  cachedToken = res.data.access_token;
  cachedExpire = now + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

async function downloadMedia(mediaId) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${token}&media_id=${mediaId}`;
  const outPath = path.join(TMP_DIR, `${mediaId}`);
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  try {
    const asText = res.data.toString();
    if (asText.startsWith('{')) {
      const maybe = JSON.parse(asText);
      if (maybe.errcode && maybe.errcode !== 0) {
        throw new Error(`media get failed: ${maybe.errmsg}`);
      }
    }
  } catch (_) {
    // binary body, ignore
  }
  fs.writeFileSync(outPath, res.data);
  return outPath;
}

module.exports = { downloadMedia, getAccessToken };
