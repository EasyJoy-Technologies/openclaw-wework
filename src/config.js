require('dotenv').config();

module.exports = {
  port: process.env.PORT || 9000,
  token: process.env.WECOM_TOKEN || '',
  encodingAESKey: process.env.WECOM_AES_KEY || '',
  corpId: process.env.WECOM_CORP_ID || '',
  agentSecret: process.env.WECOM_AGENT_SECRET || '',
  agentId: process.env.WECOM_AGENT_ID || ''
};
