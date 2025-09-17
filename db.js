const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db.json');

let db = {
  players: {},   // keyed by userId → [names]
  state: {},
  nicknames: {}  // keyed by userId → nickname
};

// Load existing data if file exists
if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    db = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load db.json, starting fresh:', err);
  }
}

// Save helper
function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// === Players (per user) ===
function addPlayers(userId, names) {
  if (!db.players[userId]) db.players[userId] = [];
  db.players[userId].push(...names);
  save();
}

function removePlayers(userId, names) {
  if (!db.players[userId]) return;
  db.players[userId] = db.players[userId].filter(n => !names.includes(n));
  if (db.players[userId].length === 0) {
    delete db.players[userId];
  }
  save();
}

function listPlayers() {
  return Object.values(db.players).flat();
}

function listUserPlayers(userId) {
  return db.players[userId] || [];
}

function clearPlayers() {
  db.players = {};
  save();
}

// === State (misc tournament data) ===
function setState(key, value) {
  db.state[key] = value;
  save();
}

function getState(key) {
  return db.state[key];
}

// === Nicknames ===
function setNickname(userId, nickname) {
  db.nicknames[userId] = nickname;
  save();
}

function getNickname(userId) {
  return db.nicknames[userId];
}

module.exports = {
  addPlayers,
  removePlayers,
  listPlayers,
  listUserPlayers,
  clearPlayers,
  setState,
  getState,
  setNickname,
  getNickname
};
