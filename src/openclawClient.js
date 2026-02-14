const WebSocket = require('ws');
const crypto = require('crypto');
const { gatewayUrl, gatewayToken } = require('./occonfig');

function uuid() {
  return crypto.randomUUID();
}

function callOpenClaw({ message, sessionKey, agentId = 'main', timeoutMs = 120000, finishOnFirstText = false, retryOnce = true }) {
  return new Promise((resolve, reject) => {
    if (!gatewayToken) {
      return reject(new Error('gateway token missing'));
    }
    if (!gatewayUrl) {
      return reject(new Error('gateway url missing'));
    }

    const reqId = uuid();
    const runId = uuid();
    let ws;
    let settled = false;
    let closing = false;
    let lastText = '';
    let hasRetried = false;

    const cleanup = () => {
      clearTimeout(timeout);
      if (ws) {
        ws.removeAllListeners('open');
        ws.removeAllListeners('message');
        ws.removeAllListeners('error');
        ws.removeAllListeners('close');
      }
    };

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      closing = true;
      try {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
        }
      } catch (_) {}
      if (err) return reject(err);
      resolve(result || lastText || '');
    };

    const start = () => {
      ws = new WebSocket(gatewayUrl);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'req',
          id: 'connect-' + reqId,
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            auth: { token: gatewayToken },
            client: { id: 'cli', displayName: 'wecom-bridge', version: '0.1', platform: 'node', mode: 'cli' }
          }
        }));
      });

      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (_) { return; }

        if (msg.type === 'event' && msg.event === 'connect.challenge') return;

        if (msg.type === 'res' && msg.id.startsWith('connect-')) {
          if (!msg.ok) {
            console.error('gateway connect res', JSON.stringify(msg));
            return finish(new Error(msg.errorMessage || msg.error || 'gateway connect failed'));
          }
          ws.send(JSON.stringify({
            type: 'req',
            id: 'agent-' + reqId,
            method: 'agent',
            params: { agentId, sessionKey, message, thinking: 'low', idempotencyKey: runId }
          }));
          return;
        }

        if (msg.type === 'res' && msg.id === 'agent-' + reqId) {
          if (!msg.ok) {
            console.error('gateway agent res', JSON.stringify(msg));
            return finish(new Error(msg.errorMessage || msg.error || 'gateway agent error'));
          }
          return; // ack only
        }

        if (msg.type === 'event' && msg.event === 'agent' && msg.payload?.runId === runId) {
          if (msg.payload.stream === 'assistant' && msg.payload.data?.text) {
            lastText = msg.payload.data.text;
            if (finishOnFirstText) return finish(null, lastText);
          }
          if (msg.payload.stream === 'lifecycle' && msg.payload.data?.phase === 'end') {
            return finish(null, lastText);
          }
        }
      });

      ws.on('error', (err) => {
        if (settled) return;
        finish(err);
      });

      ws.on('close', () => {
        if (settled || closing) return;
        if (retryOnce && !hasRetried) {
          hasRetried = true;
          setTimeout(() => start(), 300);
          return;
        }
        finish(new Error('gateway closed'));
      });
    };

    const timeout = setTimeout(() => finish(new Error('gateway timeout')), timeoutMs);
    start();
  });
}

module.exports = { callOpenClaw };
