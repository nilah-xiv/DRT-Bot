const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db.json');

let db = {
  players: {},   // keyed by userId → [names]
  state: {},
  nicknames: {}  // keyed by userId → nickname
};

function ensureShape() {
  if (!db || typeof db !== 'object') {
    db = { players: {}, state: {}, nicknames: {} };
    return;
  }
  if (!db.players || typeof db.players !== 'object') db.players = {};
  if (!db.state || typeof db.state !== 'object') db.state = {};
  if (!db.nicknames || typeof db.nicknames !== 'object') db.nicknames = {};
}

// Load existing data if file exists
if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    db = JSON.parse(raw);
    ensureShape();
  } catch (err) {
    console.error('Failed to load db.json, starting fresh:', err);
    ensureShape();
  }
} else {
  ensureShape();
}

ensureShape();

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

function getAllPlayerEntries() {
  ensureShape();
  const entries = [];
  for (const [userId, names] of Object.entries(db.players)) {
    names.forEach((name) => entries.push({ userId, name }));
  }
  return entries;
}

function clearPlayers() {
  db.players = {};
  save();
}

function clearTournamentData() {
  ensureShape();
  db.players = {};
  db.state.tournamentName = null;
  db.state.tournamentDate = null;
  db.state.tournamentTime = null;
  db.state.bracket = null;
  db.state.challongeId = null;
  db.state.challongeUrl = null;
  db.state.tournamentStatus = "none";
  save();
}
function setDefaultTz(tz) {
  ensureShape();
  db.state.defaultTz = tz;
  save();
}

function getDefaultTz() {
  ensureShape();
  return db.state.defaultTz || 'UTC';
}


// === State (misc tournament data) ===
function setState(key, value) {
  ensureShape();
  db.state[key] = value;
  save();
}

function getState(key) {
  ensureShape();
  return db.state[key];
}

// Explicit helpers for tournament status
function setTournamentStatus(status) {
  // status = "none" | "scheduled" | "in-progress"
  ensureShape();
  db.state.tournamentStatus = status;
  save();
}

function getTournamentStatus() {
  ensureShape();
  return db.state.tournamentStatus || "none";
}

// === Nicknames ===
function setNickname(userId, nickname) {
  ensureShape();
  const oldNickname = db.nicknames[userId];
  db.nicknames[userId] = nickname;
  
  // If user has existing players and they changed their nickname, update the player list
  if (oldNickname && db.players[userId]) {
    const userPlayers = db.players[userId];
    // Find if the old nickname is in their player list and replace it
    const oldNicknameIndex = userPlayers.indexOf(oldNickname);
    if (oldNicknameIndex !== -1) {
      userPlayers[oldNicknameIndex] = nickname;
    }
  }
  
  save();
}

function getNickname(userId) {
  ensureShape();
  return db.nicknames[userId];
}

function removePlayerForUser(userId, name) {
  ensureShape();
  const names = db.players[userId];
  if (!names) return false;
  const idx = names.indexOf(name);
  if (idx === -1) return false;
  names.splice(idx, 1);
  if (names.length === 0) {
    delete db.players[userId];
  }
  save();
  return true;
}

module.exports = {
  addPlayers,
  removePlayers,
  listPlayers,
  listUserPlayers,
  getAllPlayerEntries,
  clearPlayers,
  clearTournamentData,
  setState,
  getState,
  setTournamentStatus,
  getTournamentStatus,
  setNickname,
  getNickname,
  removePlayerForUser,
  setDefaultTz,
  getDefaultTz
};
