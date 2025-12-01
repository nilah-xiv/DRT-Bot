const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db.json');

// Structure: { guilds: { [guildId]: { players, state, nicknames } } }
let db = { guilds: {} };

function ensureGuildShape(guildId) {
  if (!db || typeof db !== 'object') db = { guilds: {} };
  if (!db.guilds || typeof db.guilds !== 'object') db.guilds = {};
  const gid = guildId || 'global';
  if (!db.guilds[gid]) {
    db.guilds[gid] = { players: {}, state: {}, nicknames: {} };
  }
  const g = db.guilds[gid];
  if (!g.players || typeof g.players !== 'object') g.players = {};
  if (!g.state || typeof g.state !== 'object') g.state = {};
  if (!g.nicknames || typeof g.nicknames !== 'object') g.nicknames = {};
  return g;
}

// Load existing data if file exists
if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    db = JSON.parse(raw);
    // Migrate legacy shape {players,state,nicknames} to guilds.global
    if (!db.guilds) {
      const legacyGuildId =
        (process.env.GUILD_ID && process.env.GUILD_ID.trim()) ||
        (process.env.ALLOWED_GUILD_IDS && process.env.ALLOWED_GUILD_IDS.split(',').map(s => s.trim()).filter(Boolean)[0]) ||
        'global';
      const legacy = db;
      db = { guilds: {} };
      db.guilds[legacyGuildId] = {
        players: legacy.players || {},
        state: legacy.state || {},
        nicknames: legacy.nicknames || {}
      };
      save();
    }
  } catch (err) {
    console.error('Failed to load db.json, starting fresh:', err);
    db = { guilds: {} };
  }
}

function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// === Players (per guild, per user) ===
function addPlayers(guildId, userId, names) {
  const g = ensureGuildShape(guildId);
  if (!g.players[userId]) g.players[userId] = [];
  g.players[userId].push(...names);
  save();
}

function removePlayers(guildId, userId, names) {
  const g = ensureGuildShape(guildId);
  if (!g.players[userId]) return;
  g.players[userId] = g.players[userId].filter(n => !names.includes(n));
  if (g.players[userId].length === 0) {
    delete g.players[userId];
  }
  save();
}

function listPlayers(guildId) {
  const g = ensureGuildShape(guildId);
  return Object.values(g.players).flat();
}

function listUserPlayers(guildId, userId) {
  const g = ensureGuildShape(guildId);
  return g.players[userId] || [];
}

function getAllPlayerEntries(guildId) {
  const g = ensureGuildShape(guildId);
  const entries = [];
  for (const [userId, names] of Object.entries(g.players)) {
    names.forEach((name) => entries.push({ userId, name }));
  }
  return entries;
}

function clearPlayers(guildId) {
  const g = ensureGuildShape(guildId);
  g.players = {};
  save();
}

function clearTournamentData(guildId) {
  const g = ensureGuildShape(guildId);
  g.players = {};
  g.state.tournamentName = null;
  g.state.tournamentDate = null;
  g.state.tournamentTime = null;
  g.state.bracket = null;
  g.state.challongeId = null;
  g.state.challongeUrl = null;
  g.state.tournamentStatus = 'none';
  save();
}

function setDefaultTz(guildId, tz) {
  const g = ensureGuildShape(guildId);
  g.state.defaultTz = tz;
  save();
}

function getDefaultTz(guildId) {
  const g = ensureGuildShape(guildId);
  return g.state.defaultTz || 'UTC';
}

// === State (misc tournament data) ===
function setState(guildId, key, value) {
  const g = ensureGuildShape(guildId);
  g.state[key] = value;
  save();
}

function getState(guildId, key) {
  const g = ensureGuildShape(guildId);
  return g.state[key];
}

// Explicit helpers for tournament status
function setTournamentStatus(guildId, status) {
  const g = ensureGuildShape(guildId);
  g.state.tournamentStatus = status;
  save();
}

function getTournamentStatus(guildId) {
  const g = ensureGuildShape(guildId);
  return g.state.tournamentStatus || 'none';
}

// === Nicknames ===
function setNickname(guildId, userId, nickname) {
  const g = ensureGuildShape(guildId);
  const oldNickname = g.nicknames[userId];
  g.nicknames[userId] = nickname;

  // If user has existing players and they changed their nickname, update the player list
  if (oldNickname && g.players[userId]) {
    const userPlayers = g.players[userId];
    const oldNicknameIndex = userPlayers.indexOf(oldNickname);
    if (oldNicknameIndex !== -1) {
      userPlayers[oldNicknameIndex] = nickname;
    }
  }

  save();
}

function getNickname(guildId, userId) {
  const g = ensureGuildShape(guildId);
  return g.nicknames[userId];
}

function removePlayerForUser(guildId, userId, name) {
  const g = ensureGuildShape(guildId);
  const names = g.players[userId];
  if (!names) return false;
  const idx = names.indexOf(name);
  if (idx === -1) return false;
  names.splice(idx, 1);
  if (names.length === 0) {
    delete g.players[userId];
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
