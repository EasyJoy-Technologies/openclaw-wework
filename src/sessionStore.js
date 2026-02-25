const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'sessions.json');
const MAX_HISTORY = 20; // 保留最近20条（10轮对话）

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ users: {} }, null, 2));
}

function load() {
  ensureFile();
  try {
    const raw = fs.readFileSync(FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { users: {} };
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

// 兼容旧格式：若存的是字符串，迁移为新格式
function migrateUser(entry) {
  if (!entry || typeof entry === 'string') {
    return { history: [], updatedAt: Date.now() };
  }
  return entry;
}

function getHistory(userId) {
  const data = load();
  const entry = migrateUser(data.users[userId]);
  return entry.history || [];
}

function appendHistory(userId, role, content) {
  const data = load();
  const entry = migrateUser(data.users[userId]);
  entry.history = entry.history || [];
  entry.history.push({ role, content, ts: Date.now() });
  // 超出上限时丢弃最旧的
  if (entry.history.length > MAX_HISTORY) {
    entry.history = entry.history.slice(entry.history.length - MAX_HISTORY);
  }
  entry.updatedAt = Date.now();
  data.users[userId] = entry;
  save(data);
}

function clearHistory(userId) {
  const data = load();
  data.users[userId] = { history: [], updatedAt: Date.now() };
  save(data);
}

// 兼容旧接口（server.js 原来用的）
function getSession(userId) {
  return `wecom:${userId}`;
}

function setSession(userId, sessionKey) {
  // no-op，保留兼容性
}

module.exports = {
  getHistory,
  appendHistory,
  clearHistory,
  getSession,
  setSession,
};
