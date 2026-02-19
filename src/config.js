require('dotenv').config();

module.exports = {
  port: process.env.PORT || 9000,
  token: process.env.WECOM_TOKEN || '',
  encodingAESKey: process.env.WECOM_AES_KEY || '',
  corpId: process.env.WECOM_CORP_ID || '',
  agentSecret: process.env.WECOM_AGENT_SECRET || process.env.WECOM_SECRET || '',
  agentId: process.env.WECOM_AGENT_ID || '',
  clawUrl: process.env.CLAW_URL || 'http://127.0.0.1:18789/v1/responses',
  clawToken: process.env.CLAW_TOKEN || ''
};
