const axios = require('axios');
const { getAccessToken } = require('./media');
const { agentId } = require('./config');

async function sendText(toUser, content) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
  const payload = {
    touser: toUser,
    msgtype: 'text',
    agentid: parseInt(agentId, 10),
    text: { content },
    duplicate_check_interval: 600,
  };
  const res = await axios.post(url, payload);
  if (res.data.errcode !== 0) {
    throw new Error(`sendText failed: ${res.data.errmsg}`);
  }
  return res.data;
}

module.exports = { sendText };
