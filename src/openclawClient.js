const WebSocket = require('ws');
const crypto = require('crypto');
const { gatewayToken } = require('./occonfig');

const GATEWAY_URL = 'ws://127.0.0.1:18789/ws';

function uuid() {
  return crypto.randomUUID();
}

function callOpenClaw({ message, sessionKey, agentId = 'main', timeoutMs = 60000, finishOnFirstText = false }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL);
    const reqId = uuid();
    const runId = uuid();
    let settled = false;
    let lastText = '';

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(); } catch (_) {}
      if (err) return reject(err);
      resolve(result || lastText || '');
    };

    const timeout = setTimeout(() => finish(new Error('gateway timeout')), timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'req',
        id: 'connect-' + reqId,
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          auth: { token: gatewayToken },
          client: {
            id: 'cli',
            displayName: 'wecom-bridge',
            version: '0.1',
            platform: 'node',
            mode: 'cli'
          }
        }
      }));
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }

      if (msg.type === 'event' && msg.event === 'connect.challenge') return;

      if (msg.type === 'res' && msg.id.startsWith('connect-') && msg.ok) {
        ws.send(JSON.stringify({
          type: 'req',
          id: 'agent-' + reqId,
          method: 'agent',
          params: {
            agentId,
            sessionKey,
            message,
            thinking: 'low',
            idempotencyKey: runId
          }
        }));
        return;
      }

      if (msg.type === 'res' && msg.id === 'agent-' + reqId) {
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

    ws.on('error', (err) => finish(err));
    ws.on('close', () => finish(new Error('gateway closed')));
  });
}

module.exports = { callOpenClaw };
