const { PermissionFlagsBits } = require('discord.js');
const cfg = require('./config');
const store = require('./store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => `${n < 0 ? '-' : ''}${cfg.CURRENCY}${Math.abs(Math.trunc(n)).toLocaleString('en-US')}`;
const signed = (n) => `${n >= 0 ? '+' : '-'}${fmt(Math.abs(n))}`;
const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const jump = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

// "500", "2.5k", "1,000", "3m", and when a balance is given: "all", "max", "half"
function parseAmount(input, balance = null) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase().replace(/[,_\s$£]/g, '');
  if (balance != null) {
    if (s === 'all' || s === 'max') return balance;
    if (s === 'half') return Math.floor(balance / 2);
  }
  const m = s.match(/^(\d+(?:\.\d+)?)([kmb]?)$/);
  if (!m) return null;
  const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]];
  const n = Math.floor(parseFloat(m[1]) * mult);
  return Number.isSafeInteger(n) ? n : null;
}

// Accepts <:name:id>, <a:name:id> or a unicode emoji. Returns a button emoji object or null.
function parseEmoji(input) {
  const s = String(input || '').trim();
  const custom = s.match(/^<(a)?:(\w{2,32}):(\d{17,21})>$/);
  if (custom) return { id: custom[3], name: custom[2], animated: Boolean(custom[1]) };
  if (s && !/[A-Za-z<>:]/.test(s) && [...s].length <= 10) return { name: s };
  return null;
}

// Emojis for a server, each as { btn: <button emoji>, txt: <string for text> }
function emojiSet(guildId) {
  const overrides = store.guild(guildId).config.emojis;
  const out = {};
  for (const [key, fallback] of Object.entries(cfg.DEFAULT_EMOJIS)) {
    const str = overrides[key] || fallback;
    out[key] = { btn: parseEmoji(str) || { name: fallback }, txt: str };
  }
  return out;
}

function memberRoleIds(member) {
  if (!member) return [];
  if (member.roles?.cache) return [...member.roles.cache.keys()];
  return Array.isArray(member.roles) ? member.roles : [];
}

// Can change settings, emojis and the admin role: bot owners and Manage Server
function canConfigure(interaction) {
  if (cfg.OWNER_IDS.includes(interaction.user.id)) return true;
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

// Can grant cash and handle redeems: the above, plus the configured admin role
function isAdmin(interaction) {
  if (canConfigure(interaction)) return true;
  const roleId = store.guild(interaction.guildId).config.adminRoleId;
  return Boolean(roleId && memberRoleIds(interaction.member).includes(roleId));
}

// Post a line to the server's casino log channel, if one is set
async function log(client, guildId, content) {
  const channelId = store.guild(guildId).config.logChannelId;
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    await ch.send({ content, allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn('[casino] log channel send failed:', err.message);
  }
}

module.exports = { sleep, fmt, signed, ts, jump, parseAmount, parseEmoji, emojiSet, canConfigure, isAdmin, log };
