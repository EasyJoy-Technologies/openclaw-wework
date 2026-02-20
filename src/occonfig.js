require('dotenv').config();
const fs = require('fs');
const path = require('path');

function loadOpenclawConfig() {
  const candidate = process.env.OPENCLAW_CONFIG_PATH || path.join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');
  try {
    const raw = fs.readFileSync(candidate, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('loadOpenclawConfig failed', e.message);
    return {};
  }
}

function normalizeWsUrl(url) {
  if (!url) return '';
  if (!url.endsWith('/ws')) {
    const trimmed = url.endsWith('/') ? url.slice(0, -1) : url;
    return `${trimmed}/ws`;
  }
  return url;
}

function resolveGatewayConfig() {
  const cfg = loadOpenclawConfig();
  const fromEnvUrl = process.env.GATEWAY_URL;
  const fromEnvToken = process.env.GATEWAY_TOKEN;

  const fallbackPort = cfg.gateway?.port || 18789;
  const url = normalizeWsUrl(fromEnvUrl || cfg.gateway?.remote?.url || `ws://127.0.0.1:${fallbackPort}/ws`);
  const token = fromEnvToken || cfg.gateway?.remote?.token || cfg.gateway?.auth?.token || '';
  console.error("gateway token hash", require("crypto").createHash("sha256").update(String(token)).digest("hex"));
  return { gatewayUrl: url, gatewayToken: token };
}

module.exports = resolveGatewayConfig();
