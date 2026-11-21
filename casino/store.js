const fs = require('fs');
const path = require('path');
const { DATA_FILE } = require('./config');

let data = { guilds: {}, games: {} };
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(DATA_FILE)) {
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
    console.error(`[casino] Could not read ${DATA_FILE}. Moved it to ${backup} and started fresh.`, err);
    try { fs.renameSync(DATA_FILE, backup); } catch {}
    data = { guilds: {}, games: {} };
  }
  data.guilds ??= {};
  data.games ??= {};
}

// Write to a temp file then rename, so a crash mid-write never corrupts balances
function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function guild(guildId) {
  const g = (data.guilds[guildId] ??= {});
  g.config ??= {};
  g.config.emojis ??= {};
  g.users ??= {};
  g.rewards ??= [];
  g.redeems ??= {};
  g.redeemSeq ??= 0;
  g.esp ??= {};
  return g;
}

function user(guildId, userId) {
  const g = guild(guildId);
  const u = (g.users[userId] ??= { balance: 0 });
  u.stats ??= { played: 0, won: 0, lost: 0, wagered: 0, profit: 0, biggestWin: 0, bestMulti: 0 };
  return u;
}

module.exports = {
  load,
  save,
  guild,
  user,
  get games() {
    return data.games;
  },
};
