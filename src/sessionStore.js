const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'sessions.json');

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

function getSession(userId) {
  const data = load();
  return data.users[userId];
}

function setSession(userId, sessionKey) {
  const data = load();
  data.users[userId] = sessionKey;
  save(data);
}

module.exports = {
  getSession,
  setSession,
};
