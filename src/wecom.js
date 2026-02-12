const WXBizMsgCrypt = require('wechat-crypto');
const { token, encodingAESKey, corpId } = require('./config');

const crypt = new WXBizMsgCrypt(token, encodingAESKey, corpId);

function verifySignature({ msgSignature, timestamp, nonce, echostr }) {
  const signature = crypt.getSignature(timestamp, nonce, echostr);
  return signature === msgSignature;
}

function decryptEcho(echostr) {
  const result = crypt.decrypt(echostr);
  return result.message;
}

function decryptMessage(encrypted) {
  const { message } = crypt.decrypt(encrypted);
  return message;
}

module.exports = {
  crypt,
  verifySignature,
  decryptEcho,
  decryptMessage,
};
