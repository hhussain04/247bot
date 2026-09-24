// moderation.js: text moderation commands for the 247 bot.
//
// Wired into index.js by patch-index.mjs:
//   import * as mod from './moderation.js';
//   mod.attach(client);
//   if (await mod.handleMessage(message)) return;   // inside messageCreate

import fs from 'node:fs';
import { Colors, EmbedBuilder, PermissionFlagsBits } from 'discord.js';

const PREFIX = '-';

// Permanent access to every command in every server.
export const SUPER_IDS = new Set([
  '379943872278822922',
  '710963509910962258',
]);
if (process.env.OWNER_ID) SUPER_IDS.add(process.env.OWNER_ID);

export const isSuper = (userId) => SUPER_IDS.has(userId);

// Commands handled here.
const COMMANDS = [
  'help', 'strip', 'role', 'roleban', 'roleunban', 'rolebans',
  'timeout', 'untimeout', 'ban', 'unban', 'rt', 'alias',
  'puppify', 'catify', 'goon', 'forcenick', 'lock', 'unlock', 'invitedby',
  'copychannelperms', 'purge', 'bc', 'whitelist', 'unwhitelist',
  'say', 'phrase', 'imute', 'iunmute', 'rmute', 'runmute', 'forceng',
  'snipe', 'editsnipe', 'reactionsnipe', 'clearsnipe', 'snipeperms',
  'perms', 'removeperm',
  'setwelcomechannel', 'changewelcomechannel', 'removewelcomebinding',
  'setgoodbyechannel', 'changegoodbyechannel', 'removegoodbyebinding',
];
const SUPER_ONLY = new Set([
  'perms', 'removeperm', 'whitelist', 'unwhitelist', 'snipeperms',
]);
// An @ trigger on one of these three still fires on a reply ping.
const RT_REPLY_TARGETS = new Set([
  '379943872278822922',
  '710963509910962258',
  '1535620349209874502',
]);

// Granted separately with -snipeperms.
const SNIPE_CMDS = new Set(['snipe', 'editsnipe', 'reactionsnipe']);


// Commands handled in index.js. Listed so -removeperm can target them
// and so aliases can't shadow them.
const INDEX_COMMANDS = [
  'gif', 'reconnect', 'muzzle', 'unmuzzle', 'muzzleembed',
  'status', 'uptime', 'ping', 'rejoin', 'logs', 'move',
];

const BUILTIN_ALIASES = {
  r: 'role',
  obliterate: 'ban',
  to: 'timeout',
  mute: 'timeout',
  unmute: 'untimeout',
  unimute: 'iunmute',
  unrmute: 'runmute',
  fn: 'forcenick',
  unfn: 'forcenick',
  l: 'lock',
  ul: 'unlock',
  ccp: 'copychannelperms',
  forceenglish: 'forceng',
  c: 'purge',
  s: 'snipe',
  es: 'editsnipe',
  rs: 'reactionsnipe',
  cs: 'clearsnipe',
  sp: 'snipeperms',
  wl: 'whitelist',
  unwl: 'unwhitelist',
  commands: 'help',
};

// ---------- state ----------
const STATE_FILE = new URL('./mod-state.json', import.meta.url).pathname;

let state = { guilds: {} };
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  state.guilds ??= {};
} catch {
  // first run
}

function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error(`mod state save failed: ${error.message}`);
  }
}

function guildState(guildId) {
  if (!Object.hasOwn(state.guilds, guildId)) state.guilds[guildId] = {};
  const gs = state.guilds[guildId];
  gs.perms ??= {};
  gs.roleBans ??= {};
  gs.reactions ??= [];
  gs.aliases ??= {};
  gs.pets ??= {};
  gs.nicks ??= {};
  gs.locks ??= {};
  gs.invitedBy ??= {};
  gs.immune ??= {};
  gs.snipers ??= {};
  gs.phrases ??= {};
  gs.muteRoles ??= {};
  gs.mutes ??= [];
  gs.english ??= [];
  return gs;
}

const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);

// ---------- access ----------
export function canUse(userId, guildId, command) {
  if (isSuper(userId)) return true;
  if (!guildId || SUPER_ONLY.has(command)) return false;
  const entry = own(own(state.guilds, guildId)?.perms, userId);
  return Boolean(entry) && !(entry.denied ?? []).includes(command);
}

// Whitelisted users are ignored by the commands they're whitelisted from.
export function isImmune(userId, guildId, command) {
  const list = own(own(state.guilds, guildId)?.immune, userId);
  if (!list?.length) return false;
  return list.includes('all') || list.includes(command);
}

const canSnipe = (userId, guildId) =>
  Boolean(own(own(state.guilds, guildId)?.snipers, userId));

function resolveCommand(guildId, name, { includeIndex = false } = {}) {
  const key = name?.toLowerCase().replace(/^-+/, '');
  if (!key) return null;
  if (COMMANDS.includes(key)) return key;
  if (includeIndex && INDEX_COMMANDS.includes(key)) return key;
  // Phrase commands can be whitelisted by name too.
  if (includeIndex && own(state.guilds[guildId]?.phrases, key)) return key;
  return own(own(state.guilds, guildId)?.aliases, key)
    ?? own(BUILTIN_ALIASES, key)
    ?? null;
}

// ---------- helpers ----------
// Replies are embeds: green check, red cross, or plain for lists.
// The check and cross emojis come from this server.
const EMOJI_GUILD = '1411069905478095020';
const COLORS = { ok: 0x57f287, fail: 0xed4245, info: 0x2b2d31 };
const FALLBACK = { check: '✅', cross: '❌' };
const emojiCache = new Map();

function icon(client, name) {
  if (emojiCache.has(name)) return emojiCache.get(name);
  const found = client.guilds.cache.get(EMOJI_GUILD)?.emojis.cache
    .find((e) => e.name === name)?.toString();
  if (found) emojiCache.set(name, found);
  return found ?? FALLBACK[name];
}

function buildEmbed(client, kind, content) {
  const prefix = kind === 'info' ? ''
    : `${icon(client, kind === 'ok' ? 'check' : 'cross')} `;
  return new EmbedBuilder()
    .setColor(COLORS[kind])
    .setDescription(`${prefix}${content}`.slice(0, 4096));
}

function reply(message, kind, content) {
  return message.reply({
    embeds: [buildEmbed(message.client, kind, content)],
    allowedMentions: { parse: [] },
  }).catch(() => null);
}

const say = (message, content) => reply(message, 'fail', content);
export const fail = say;
export const ok = (message, content) => reply(message, 'ok', content);
const info = (message, content) => reply(message, 'info', content);

const by = (message) =>
  `by ${message.author.username} (${message.author.id})`;

function idFrom(token) {
  const match = token?.match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  return match ? (match[1] ?? match[2]) : null;
}

function resolveMember(guild, token) {
  const id = idFrom(token);
  return id ? guild.members.fetch(id).catch(() => null) : null;
}

function resolveRole(guild, text) {
  const query = text?.trim();
  if (!query) return null;

  const id = query.match(/^<@&(\d{17,20})>$|^(\d{17,20})$/);
  if (id) return guild.roles.cache.get(id[1] ?? id[2]) ?? null;

  const lower = query.toLowerCase();
  const roles = guild.roles.cache.filter((r) => r.id !== guild.id);
  const exact = roles.find((r) => r.name.toLowerCase() === lower);
  if (exact) return exact;

  const partial = roles.filter((r) => r.name.toLowerCase().startsWith(lower));
  return partial.size === 1 ? partial.first() : null;
}

function resolveAnyRole(guild, text) {
  const name = text?.trim().toLowerCase().replace(/^@/, '');
  if (name === 'everyone') return guild.roles.everyone;
  return resolveRole(guild, text);
}

function parseColor(input) {
  const text = input?.trim();
  if (!text) return null;
  const hex = text.replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(hex)) return Number.parseInt(hex, 16);
  if (text.toLowerCase() === 'random') {
    return Math.floor(Math.random() * 0xffffff);
  }
  const key = Object.keys(Colors)
    .find((k) => k.toLowerCase() === text.toLowerCase());
  return key ? Colors[key] : null;
}

const UNITS = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 };
const MAX_TIMEOUT = 28 * 86400e3;

function parseDuration(token) {
  const match = token?.toLowerCase().match(/^(\d+)(s|m|h|d|w)$/);
  const ms = match ? Number(match[1]) * UNITS[match[2]] : 0;
  return ms > 0 ? ms : null;
}

function phraseRegex(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'iu');
}

// Returns an error string, or null if the caller may act on the target.
function targetProblem(message, target, command) {
  const callerId = message.author.id;
  const guild = message.guild;
  if (target.id === message.client.user.id) return 'Not on me.';
  if (command && isImmune(target.id, message.guildId, command)) {
    return `${target} is whitelisted from \`-${command}\`.`;
  }
  if (isSuper(target.id) && !isSuper(callerId)) {
    return "You can't use that on a bot admin.";
  }
  if (isSuper(callerId) || callerId === guild.ownerId) return null;
  if (
    target.id === guild.ownerId ||
    target.roles.highest.position >= message.member.roles.highest.position
  ) {
    return 'Their top role is equal to or above yours.';
  }
  return null;
}

function roleProblem(message, role) {
  const guild = message.guild;
  const callerId = message.author.id;
  if (role.id === guild.id) return "That's @everyone.";
  if (role.managed) return `${role} is managed by an integration.`;
  if (role.position >= guild.members.me.roles.highest.position) {
    return `${role} is above my role. Drag my role higher.`;
  }
  if (
    !isSuper(callerId) &&
    callerId !== guild.ownerId &&
    role.position >= message.member.roles.highest.position
  ) {
    return `${role} is above your top role.`;
  }
  return null;
}

// ---------- puppify / catify ----------
const webhookCache = new Map();

async function getWebhook(channel) {
  const base = channel.isThread() ? channel.parent : channel;
  if (!base?.fetchWebhooks) return null;
  if (webhookCache.has(base.id)) return webhookCache.get(base.id);

  const hooks = await base.fetchWebhooks();
  const hook = hooks.find((h) => h.owner?.id === base.client.user.id && h.token)
    ?? await base.createWebhook({ name: 'gridbot mimic' });
  webhookCache.set(base.id, hook);
  return hook;
}

// Posts as someone else, using their name and avatar.
async function speakAs(channel, member, content) {
  const hook = await getWebhook(channel);
  if (!hook) return false;

  // Webhook names can't contain "discord" or "clyde".
  const name = member.displayName.replace(/discord|clyde/gi, '').trim() || 'someone';

  try {
    await hook.send({
      content,
      username: name.slice(0, 80),
      avatarURL: member.displayAvatarURL(),
      threadId: channel.isThread() ? channel.id : undefined,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    webhookCache.delete(channel.isThread() ? channel.parentId : channel.id);
    throw error;
  }
  return true;
}

// Deletes the message and reposts it with one sound per word.
async function petify(message, sound) {
  if (!message.member) return false;
  const words = message.content.split(/\s+/).filter(Boolean).length || 1;
  const content = Array(Math.min(words, 300)).fill(sound).join(' ');
  await message.delete();
  return speakAs(message.channel, message.member, content);
}

async function setPet(message, args, sound, command) {
  const target = await resolveMember(message.guild, args[0]);
  if (!target) return say(message, `Usage: \`-${command} @user\` (run it again to undo)`);

  const problem = targetProblem(message, target, command);
  if (problem) return say(message, problem);

  const gs = guildState(message.guildId);
  if (gs.pets[target.id] === sound) {
    delete gs.pets[target.id];
    save();
    return ok(message, `${target} can talk normally again.`);
  }

  gs.pets[target.id] = sound;
  save();
  return ok(message, `${target} can only ${sound} now. Run \`-${command} @user\` again to undo.`);
}

// ---------- speaking as people ----------
// Posts the text once as the target, or as everyone, then removes the command.
async function speakOnce(message, args, content, command) {
  const token = args[0]?.toLowerCase();
  const all = message.mentions.everyone || token === '@everyone' || token === 'everyone';
  const blocked = (id) =>
    isImmune(id, message.guildId, command) || isImmune(id, message.guildId, 'say');

  if (all) {
    const members = [...message.guild.members.cache.values()]
      .filter((m) => !m.user.bot && !isSuper(m.id) && !blocked(m.id))
      .slice(0, GOON_LIMIT);
    if (!members.length) return say(message, 'Nobody to do that to.');

    await message.delete().catch(() => {});
    for (const member of members) {
      await speakAs(message.channel, member, content).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  const target = await resolveMember(message.guild, args[0]);
  if (!target) return say(message, `Usage: \`-${command} @user\` or \`-${command} @everyone\``);

  const problem = targetProblem(message, target, command) ??
    (isImmune(target.id, message.guildId, 'say') ? `${target} is whitelisted from \`-say\`.` : null);
  if (problem) return say(message, problem);

  await message.delete().catch(() => {});
  const sent = await speakAs(message.channel, target, content);
  if (!sent) return say(message, 'I need Manage Webhooks in this channel.');
  return null;
}

// ---------- snipes ----------
// Kept in memory only, newest first, ten per channel.
const SNIPE_LIMIT = 10;
const snipes = { delete: new Map(), edit: new Map(), reaction: new Map() };

function pushSnipe(kind, channelId, entry) {
  const list = snipes[kind].get(channelId) ?? [];
  list.unshift(entry);
  snipes[kind].set(channelId, list.slice(0, SNIPE_LIMIT));
}

const SNIPE_LABEL = {
  delete: 'deleted messages',
  edit: 'edited messages',
  reaction: 'removed reactions',
};

async function showSnipe(message, args, kind) {
  const named = channelFrom(message.guild, args[0]);
  const channel = named ?? message.channel;
  const rest = named ? args.slice(1) : args;
  const index = Number(rest[0] ?? 1);

  const list = snipes[kind].get(channel.id) ?? [];
  if (!list.length) return say(message, `No ${SNIPE_LABEL[kind]} to snipe in ${channel}.`);
  if (!Number.isInteger(index) || index < 1 || index > list.length) {
    return say(message, `Pick 1 to ${list.length}.`);
  }

  const entry = list[index - 1];
  const user = await message.client.users.fetch(entry.userId).catch(() => null);

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setAuthor({
      name: user?.username ?? 'unknown user',
      iconURL: user?.displayAvatarURL(),
    })
    .setTimestamp(entry.at)
    .setFooter({ text: `${index}/${list.length}` });

  if (kind === 'reaction') {
    embed.setDescription(`removed ${entry.emoji} from [this message](${entry.url})`);
  } else {
    embed.setDescription(entry.content || '(no text)');
    if (kind === 'edit') embed.addFields({ name: 'Edited', value: `[jump](${entry.url})` });
    if (entry.image) embed.setImage(entry.image);
  }

  return message.reply({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
}

// ---------- purge ----------
const GOON_LIMIT = 30;

const MEDIA = {
  image: (m) =>
    m.attachments.some((a) => a.contentType?.startsWith('image/')) ||
    m.embeds.some((e) => e.image || e.thumbnail),
  video: (m) =>
    m.attachments.some((a) => a.contentType?.startsWith('video/')) ||
    m.embeds.some((e) => e.video),
  gif: (m) =>
    m.attachments.some((a) => /\.gif$/i.test(a.name ?? '')) ||
    m.embeds.some((e) => e.data?.type === 'gifv' || /\.gif/i.test(e.thumbnail?.url ?? '')),
};

async function purge(message, args, forced) {
  const { channel, guild } = message;
  if (!channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageMessages)) {
    return say(message, 'I need Manage Messages in this channel.');
  }

  let filter = forced;
  let rest = args;

  if (!filter) {
    const token = args[0]?.toLowerCase();
    const userId = idFrom(args[0]);
    if (userId) {
      if (isImmune(userId, message.guildId, 'purge')) {
        return say(message, `<@${userId}> is whitelisted from \`-purge\`.`);
      }
      filter = { type: 'user', id: userId };
      rest = args.slice(1);
    } else if (token === 'bot' || token === 'bots') {
      filter = { type: 'bot' };
      rest = args.slice(1);
    } else if (token && Object.hasOwn(MEDIA, token.replace(/s$/, ''))) {
      filter = { type: 'media', kind: token.replace(/s$/, '') };
      rest = args.slice(1);
    }
  }

  const amount = rest[0] === undefined && filter ? 20 : Number(rest[0]);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
    return say(message, 'Usage: `-purge 20`, `-purge @user 20`, `-purge bot 20`, `-purge image|video|gif 20`');
  }

  const matches = (m) => {
    if (!filter) return true;
    if (filter.type === 'user') return m.author.id === filter.id;
    if (filter.type === 'bot') return m.author.bot;
    return MEDIA[filter.kind](m);
  };

  const fetched = await channel.messages.fetch({ limit: 100 });
  const picked = [...fetched.values()]
    .filter((m) => m.id !== message.id && matches(m))
    .slice(0, amount);

  await message.delete().catch(() => {});
  if (!picked.length) {
    const none = await channel.send({ embeds: [buildEmbed(message.client, 'fail', 'Nothing to delete.')] });
    setTimeout(() => none.delete().catch(() => {}), 5_000);
    return null;
  }

  const deleted = await channel.bulkDelete(picked, true);
  const skipped = picked.length - deleted.size;
  const notice = await channel.send({
    embeds: [buildEmbed(message.client, 'ok',
      `Deleted ${deleted.size} messages.` +
      (skipped ? ` ${skipped} were over 14 days old and left alone.` : ''))],
  });
  setTimeout(() => notice.delete().catch(() => {}), 5_000);
  return null;
}

// ---------- image and reaction mutes ----------
// Same approach as bleed: a dedicated role denied the permission in every channel.
const MUTE_ROLES = {
  image: { name: 'Image Muted', deny: ['AttachFiles', 'EmbedLinks'], verb: 'image muted' },
  reaction: { name: 'Reaction Muted', deny: ['AddReactions'], verb: 'reaction muted' },
};

async function ensureMuteRole(guild, kind) {
  const gs = guildState(guild.id);
  const { name, deny } = MUTE_ROLES[kind];

  let role = gs.muteRoles[kind] ? guild.roles.cache.get(gs.muteRoles[kind]) : null;
  role ??= guild.roles.cache.find((r) => r.name === name);
  role ??= await guild.roles.create({ name, reason: `${name} role` });

  gs.muteRoles[kind] = role.id;
  save();

  const denied = Object.fromEntries(deny.map((p) => [p, false]));
  for (const channel of guild.channels.cache.values()) {
    if (channel.isThread?.()) continue;
    const overwrite = channel.permissionOverwrites?.cache.get(role.id);
    if (overwrite && deny.every((p) => overwrite.deny.has(PermissionFlagsBits[p]))) continue;
    if (!channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageRoles)) continue;
    await channel.permissionOverwrites.edit(role.id, denied, { reason: `${name} role` })
      .catch(() => {});
  }
  return role;
}

async function setMute(message, args, kind, muting) {
  const command = `${kind === 'image' ? 'i' : 'r'}mute`;
  const target = await resolveMember(message.guild, args[0]);
  if (!target) {
    return say(message, `Usage: \`-${muting ? command : command.replace('mute', 'unmute')} @user${muting ? ' [10m] [reason]' : ''}\``);
  }

  const problem = targetProblem(message, target, command);
  if (problem) return say(message, problem);

  const role = await ensureMuteRole(message.guild, kind);
  if (role.position >= message.guild.members.me.roles.highest.position) {
    return say(message, `${role} is above my role. Drag my role higher.`);
  }

  const gs = guildState(message.guildId);
  gs.mutes = gs.mutes.filter((m) => !(m.userId === target.id && m.kind === kind));

  if (!muting) {
    if (!target.roles.cache.has(role.id)) {
      return say(message, `${target} isn't ${MUTE_ROLES[kind].verb}.`);
    }
    await target.roles.remove(role, `un${command} ${by(message)}`);
    save();
    return ok(message, `${target} is no longer ${MUTE_ROLES[kind].verb}.`);
  }

  const ms = parseDuration(args[1]);
  const reason = args.slice(ms ? 2 : 1).join(' ');
  await target.roles.add(role, reason ? `${reason} (${by(message)})` : by(message));

  if (ms) gs.mutes.push({ userId: target.id, kind, until: Date.now() + ms });
  save();

  return ok(message, `${target} is now ${MUTE_ROLES[kind].verb}${ms ? ` for ${args[1]}` : ''}.`);
}

// ---------- channel lock ----------
const SEND = PermissionFlagsBits.SendMessages;
const SEND_THREADS = PermissionFlagsBits.SendMessagesInThreads;

// true allowed, false denied, null not set.
const valueOf = (overwrite, bit) => {
  if (!overwrite) return null;
  if (overwrite.allow.has(bit)) return true;
  if (overwrite.deny.has(bit)) return false;
  return null;
};

const previous = (overwrite) => ({
  SendMessages: valueOf(overwrite, SEND),
  SendMessagesInThreads: valueOf(overwrite, SEND_THREADS),
});

async function setLock(message, locking) {
  const { channel, guild } = message;
  const me = guild.members.me;
  const gs = guildState(message.guildId);
  const reason = `${locking ? 'lock' : 'unlock'} ${by(message)}`;

  if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageRoles)) {
    return say(message, 'I need Manage Permissions in this channel.');
  }

  if (!locking) {
    const saved = gs.locks[channel.id];
    if (!saved) return say(message, "This channel isn't locked.");
    for (const entry of saved) {
      await channel.permissionOverwrites.edit(entry.id, entry.prev, { reason }).catch(() => {});
    }
    delete gs.locks[channel.id];
    save();
    return ok(message, 'Channel unlocked.');
  }

  if (gs.locks[channel.id]) return say(message, 'This channel is already locked.');

  // @everyone, plus anything that is explicitly allowed to talk and isn't admin.
  const targets = new Set([guild.roles.everyone.id]);
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (overwrite.id === me.id) continue;
    if (!overwrite.allow.has(SEND) && !overwrite.allow.has(SEND_THREADS)) continue;

    const role = guild.roles.cache.get(overwrite.id);
    if (role) {
      if (role.permissions.has(PermissionFlagsBits.Administrator)) continue;
    } else {
      const member = await guild.members.fetch(overwrite.id).catch(() => null);
      if (member?.permissions.has(PermissionFlagsBits.Administrator)) continue;
    }
    targets.add(overwrite.id);
  }

  const changes = [];

  // Keep myself able to talk so I can still reply and unlock.
  changes.push({ id: me.id, prev: previous(channel.permissionOverwrites.cache.get(me.id)) });
  await channel.permissionOverwrites.edit(
    me.id, { SendMessages: true, SendMessagesInThreads: true }, { reason });

  for (const id of targets) {
    changes.push({ id, prev: previous(channel.permissionOverwrites.cache.get(id)) });
    await channel.permissionOverwrites.edit(
      id, { SendMessages: false, SendMessagesInThreads: false }, { reason });
  }

  gs.locks[channel.id] = changes;
  save();
  return ok(message, 'Channel locked. Anyone with Administrator can still talk.');
}

// ---------- invite tracking ----------
// Invite uses are cached so a join can be matched to the code that went up.
// Needs Manage Server.
const inviteCache = new Map();

const snapshot = (invites) => new Map(invites.map((i) =>
  [i.code, { uses: i.uses ?? 0, inviterId: i.inviter?.id ?? null }]));

async function cacheInvites(guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (invites) inviteCache.set(guild.id, snapshot(invites));
}

async function findInviter(guild) {
  const before = inviteCache.get(guild.id) ?? new Map();
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;

  const after = snapshot(invites);
  inviteCache.set(guild.id, after);

  for (const [code, now] of after) {
    if (now.uses > (before.get(code)?.uses ?? 0)) {
      return { code, inviterId: now.inviterId, uses: now.uses };
    }
  }

  // A one-use invite is deleted the moment it is used.
  for (const [code, was] of before) {
    if (!after.has(code)) {
      return { code, inviterId: was.inviterId, uses: was.uses + 1 };
    }
  }

  const vanity = await guild.fetchVanityData().catch(() => null);
  return vanity?.code
    ? { code: vanity.code, inviterId: null, uses: vanity.uses ?? 0 }
    : null;
}

// ---------- welcome / goodbye ----------
const GREETINGS = {
  welcome: { color: 0x57f287, text: 'welcome loser', label: 'Joined' },
  goodbye: { color: 0xed4245, text: 'u wont be missed', label: 'Left' },
};

function channelFrom(guild, token) {
  const id = token?.match(/^<#(\d{17,20})>$|^(\d{17,20})$/);
  const channel = id ? guild.channels.cache.get(id[1] ?? id[2]) : null;
  return channel?.isTextBased() ? channel : null;
}

async function bindGreeting(message, args, kind, mode) {
  const gs = guildState(message.guildId);
  const current = gs[kind];
  const cmd = {
    set: `-set${kind}channel`,
    change: `-change${kind}channel`,
    remove: `-remove${kind}binding`,
  };

  if (mode === 'remove') {
    if (!current) return say(message, `No ${kind} channel is set.`);
    if (args[0] && channelFrom(message.guild, args[0])?.id !== current) {
      return say(message, `The ${kind} channel is <#${current}>, not that one.`);
    }
    delete gs[kind];
    save();
    return ok(message, `Removed the ${kind} channel (was <#${current}>).`);
  }

  const channel = channelFrom(message.guild, args[0]);
  if (!channel) return say(message, `Usage: \`${cmd[mode]} #channel\` or a channel ID`);
  if (mode === 'set' && current) {
    return say(message, `The ${kind} channel is already <#${current}>. Use \`${cmd.change}\`.`);
  }
  if (mode === 'change' && !current) {
    return say(message, `No ${kind} channel is set yet. Use \`${cmd.set}\`.`);
  }

  const perms = channel.permissionsFor(message.guild.members.me);
  if (!perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
    return say(message, `I can't send embeds in ${channel}.`);
  }

  gs[kind] = channel.id;
  save();
  return ok(message, `${kind === 'welcome' ? 'Welcome' : 'Goodbye'} messages will go to ${channel}.`);
}

async function sendGreeting(member, kind, invite) {
  const channelId = own(state.guilds, member.guild.id)?.[kind];
  const channel = channelId ? member.guild.channels.cache.get(channelId) : null;
  if (!channel?.isTextBased()) return;

  const { color, text, label } = GREETINGS[kind];
  const at = kind === 'welcome' ? (member.joinedTimestamp ?? Date.now()) : Date.now();
  const unix = Math.floor(at / 1000);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(member.user.username)
    .setDescription(`${text} ${member.user}`)
    .setThumbnail(member.displayAvatarURL({ size: 256 }))
    .addFields({ name: label, value: `<t:${unix}:F> (<t:${unix}:R>)` });

  if (kind === 'welcome' && invite) {
    embed.addFields({
      name: 'Invited by',
      value: `${invite.inviterId ? `<@${invite.inviterId}>` : 'vanity URL'}` +
        ` (\`${invite.code}\`, ${invite.uses} uses)`,
    });
  }

  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

// ---------- commands ----------
const HANDLERS = {
  setwelcomechannel: (m, a) => bindGreeting(m, a, 'welcome', 'set'),
  changewelcomechannel: (m, a) => bindGreeting(m, a, 'welcome', 'change'),
  removewelcomebinding: (m, a) => bindGreeting(m, a, 'welcome', 'remove'),
  setgoodbyechannel: (m, a) => bindGreeting(m, a, 'goodbye', 'set'),
  changegoodbyechannel: (m, a) => bindGreeting(m, a, 'goodbye', 'change'),
  removegoodbyebinding: (m, a) => bindGreeting(m, a, 'goodbye', 'remove'),

  puppify: (message, args) => setPet(message, args, 'bark', 'puppify'),
  catify: (message, args) => setPet(message, args, 'meow', 'catify'),
  goon: (message, args) => speakOnce(message, args, '💦', 'goon'),

  async say(message, args) {
    const text = args.slice(1).join(' ').trim();
    if (!text) return say(message, 'Usage: `-say @user <message>`');
    return speakOnce(message, args, text, 'say');
  },

  async phrase(message, args) {
    const gs = guildState(message.guildId);
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      const lines = Object.entries(gs.phrases)
        .map(([name, text]) => `\`-${name}\` → ${text}`);
      return info(message, lines.join('\n') || 'No phrase commands yet.');
    }

    if (sub === 'add') {
      const name = args[1]?.toLowerCase().replace(/^-+/, '');
      const text = args.slice(2).join(' ').trim();
      if (!name || !text) {
        return say(message, 'Usage: `-phrase add <name> <message>`, e.g. `-phrase add ft i am a failtrader 💔`');
      }
      if (!/^[a-z0-9_]{1,20}$/.test(name)) {
        return say(message, 'Names are letters, numbers and _ only.');
      }
      if (COMMANDS.includes(name) || INDEX_COMMANDS.includes(name) ||
        own(BUILTIN_ALIASES, name) || own(gs.aliases, name)) {
        return say(message, `\`-${name}\` is already a command.`);
      }
      if (text.length > 500) return say(message, 'Keep it under 500 characters.');

      gs.phrases[name] = text;
      save();
      return ok(message, `\`-${name} @user\` will now post: ${text}`);
    }

    if (sub === 'remove' || sub === 'delete') {
      const name = args[1]?.toLowerCase().replace(/^-+/, '');
      if (!name || !own(gs.phrases, name)) return say(message, "That phrase command doesn't exist.");
      delete gs.phrases[name];
      save();
      return ok(message, `Removed \`-${name}\`.`);
    }

    return say(message, 'Usage: `-phrase add <name> <message>`, `-phrase remove <name>`, `-phrase list`');
  },

  snipe: (message, args) => showSnipe(message, args, 'delete'),
  editsnipe: (message, args) => showSnipe(message, args, 'edit'),
  reactionsnipe: (message, args) => showSnipe(message, args, 'reaction'),

  async clearsnipe(message) {
    if (!message.channel.permissionsFor(message.guild.members.me)
      ?.has(PermissionFlagsBits.ManageMessages)) {
      return say(message, 'I need Manage Messages in this channel.');
    }
    for (const store of Object.values(snipes)) store.delete(message.channel.id);
    return ok(message, 'Cleared the snipes for this channel.');
  },

  purge: (message, args) => purge(message, args, null),
  bc: (message, args) => purge(message, args, { type: 'bot' }),

  async invitedby(message, args) {
    const id = idFrom(args[0]);
    if (!id) return say(message, 'Usage: `-invitedby @user`');
    const record = own(guildState(message.guildId).invitedBy, id);
    if (!record) return say(message, `No invite recorded for <@${id}>.`);
    return info(message, `<@${id}> joined with \`${record.code}\` from ` +
      `${record.inviterId ? `<@${record.inviterId}>` : 'the vanity URL'}` +
      ` <t:${Math.floor(record.at / 1000)}:R>`);
  },

  async copychannelperms(message, args) {
    const { channel, guild } = message;
    const from = resolveAnyRole(guild, args[0]);
    const to = resolveAnyRole(guild, args[1]);
    if (!from || !to) {
      return say(message, 'Usage: `-copychannelperms @from @to`. Mention, ID, name or `everyone`.');
    }
    if (from.id === to.id) return say(message, "That's the same role twice.");

    if (!channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageRoles)) {
      return say(message, 'I need Manage Permissions in this channel.');
    }
    if (to.managed) return say(message, `${to} is managed by an integration.`);
    if (to.id !== guild.id && to.position >= guild.members.me.roles.highest.position) {
      return say(message, `${to} is above my role. Drag my role higher.`);
    }
    if (
      !isSuper(message.author.id) &&
      message.author.id !== guild.ownerId &&
      to.id !== guild.id &&
      to.position >= message.member.roles.highest.position
    ) {
      return say(message, `${to} is above your top role.`);
    }

    const source = channel.permissionOverwrites.cache.get(from.id);
    if (!source) return say(message, `${from} has no permissions set in this channel.`);

    const options = {};
    for (const name of source.allow.toArray()) options[name] = true;
    for (const name of source.deny.toArray()) options[name] = false;

    // Clear anything the target has that the source doesn't, so it's an exact copy.
    const existing = channel.permissionOverwrites.cache.get(to.id);
    if (existing) {
      for (const name of [...existing.allow.toArray(), ...existing.deny.toArray()]) {
        options[name] ??= null;
      }
    }

    await channel.permissionOverwrites.edit(to.id, options, {
      reason: `copy channel perms ${by(message)}`,
    });
    return ok(message, `Copied ${from}'s permissions in ${channel} to ${to}.`);
  },

  imute: (message, args) => setMute(message, args, 'image', true),
  iunmute: (message, args) => setMute(message, args, 'image', false),
  rmute: (message, args) => setMute(message, args, 'reaction', true),
  runmute: (message, args) => setMute(message, args, 'reaction', false),

  async forceng(message) {
    const gs = guildState(message.guildId);
    const on = gs.english.includes(message.channelId);

    gs.english = on
      ? gs.english.filter((id) => id !== message.channelId)
      : [...gs.english, message.channelId];
    save();

    return ok(message, on
      ? `No longer translating ${message.channel}.`
      : `Anything not in English in ${message.channel} will be translated underneath.`);
  },

  lock: (message) => setLock(message, true),
  unlock: (message) => setLock(message, false),

  async forcenick(message, args) {
    const target = await resolveMember(message.guild, args[0]);
    const nick = args.slice(1).join(' ').trim();
    if (!target) {
      return say(message, 'Usage: `-fn @user nickname`, or `-unfn @user` to release it');
    }

    const problem = targetProblem(message, target, 'forcenick');
    if (problem) return say(message, problem);

    const gs = guildState(message.guildId);

    if (!nick) {
      if (!gs.nicks[target.id]) return say(message, `${target} isn't force nicked.`);
      delete gs.nicks[target.id];
      save();
      return ok(message, `${target} can change their nickname again.`);
    }

    if (!target.manageable) {
      return say(message, "I can't rename them. They're the server owner or above my role.");
    }
    if (nick.length > 32) return say(message, 'Nicknames max out at 32 characters.');

    gs.nicks[target.id] = nick;
    save();
    await target.setNickname(nick, `forcenick ${by(message)}`);
    return ok(message, `${target} is now **${nick}** and can't change it.`);
  },

  async help(message) {
    const gs = guildState(message.guildId);
    const aliases = Object.entries({ ...BUILTIN_ALIASES, ...gs.aliases })
      .map(([a, c]) => `\`-${a}\` → \`-${c}\``)
      .join(', ');

    const embed = new EmbedBuilder()
      .setTitle('Bot commands')
      .setColor(0x5865f2)
      .addFields(
        {
          name: 'Roles',
          value: [
            '`-role add @user <role>` give a role',
            '`-role remove @user <role>` take a role',
            '`-role create <color> <name>` color is hex (#ff0000) or a name (red)',
            '`-strip @user` remove every role I can',
            '`-roleban @user <role>` stop them ever having a role',
            '`-roleunban @user <role>` lift a role ban',
            '`-rolebans @user` list their role bans',
          ].join('\n'),
        },
        {
          name: 'Moderation',
          value: [
            '`-timeout @user [10m] [reason]` s/m/h/d/w, max 28d',
            '`-untimeout @user`, `-mute` and `-unmute` do the same',
            '`-imute @user [10m]` block images and links, `-iunmute @user`',
            '`-rmute @user [10m]` block reactions, `-runmute @user`',
            '`-ban @user|id [reason]`',
            '`-unban <id>`',
            '`-muzzle @user` / `-unmuzzle @user` delete everything they send',
            '`-puppify @user` / `-catify @user` every word becomes bark / meow (again to undo)',
            '`-goon @user` or `-goon @everyone` posts 💦 as them once',
            '`-say @user <message>` posts anything as them once',
            '`-phrase add ft i am a failtrader 💔` makes `-ft @user` do the same',
            '`-phrase remove <name>`, `-phrase list`',
            '`-purge 20`, `-purge @user 20`, `-purge bot 20`, `-purge image|video|gif 20` (`-c`, `-bc`)',
            '`-fn @user <nickname>` lock their nickname, `-unfn @user` release it',
            '`-lock` / `-unlock` this channel, admins can still talk (`-l` / `-ul`)',
            '`-forceng` translate anything not in English in this channel, run again to stop',
            '`-copychannelperms @from @to` copy one role\'s channel permissions onto another (`-ccp`)',
          ].join('\n'),
        },
        {
          name: 'Auto reactions',
          value: [
            '`-rt add @user <emoji>` react when they get pinged',
            '`-rt add <word or phrase> <emoji>` react when it is said',
            '`-rt list`, `-rt remove <number>`, `-rt clear`',
          ].join('\n'),
        },
        {
          name: 'Welcome / goodbye',
          value: [
            '`-setwelcomechannel #channel`, `-changewelcomechannel #channel`, `-removewelcomebinding`',
            '`-setgoodbyechannel #channel`, `-changegoodbyechannel #channel`, `-removegoodbyebinding`',
            '`-invitedby @user` which invite they joined with',
          ].join('\n'),
        },
        {
          name: 'Snipes',
          value: [
            '`-s [channel] [number]` last deleted message',
            '`-es [channel] [number]` last edited message',
            '`-rs [channel] [number]` last removed reaction',
            '`-cs` clear this channel\'s snipes',
            '`-snipeperms @user` give or take snipe access, bot admins only (`-sp`)',
          ].join('\n'),
        },
        {
          name: 'Other',
          value: [
            '`-alias add <name> <command>`, `-alias remove <name>`, `-alias list`',
            '`-gif` convert an image or MP4, `-reconnect` rejoin the VC',
          ].join('\n'),
        },
        {
          name: 'Access (bot admins only)',
          value: [
            '`-perms @user` give bot access in this server',
            '`-perms` list who has access',
            '`-perms -<command> @user` give back one command',
            '`-removeperm @user` take all access',
            '`-removeperm -<command> @user` take one command',
            '`-whitelist @user [commands]` make the bot ignore them (`-wl`)',
            'e.g. `-wl @user goon iluvalli`, or `-wl @user say` for every phrase',
            '`-unwhitelist @user [commands]` undo it (`-unwl`)',
          ].join('\n'),
        },
        { name: 'Aliases', value: (aliases || 'none').slice(0, 1024) },
      );

    return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },

  async strip(message, args) {
    const target = await resolveMember(message.guild, args[0]);
    if (!target) return say(message, 'Usage: `-strip @user`');

    const problem = targetProblem(message, target, 'strip');
    if (problem) return say(message, problem);

    const all = target.roles.cache.filter((r) => r.id !== message.guild.id);
    const removable = all.filter((r) => !roleProblem(message, r));
    if (!removable.size) return say(message, `Nothing on ${target} I can remove.`);

    await target.roles.remove(removable, `strip ${by(message)}`);
    const kept = all.size - removable.size;
    return ok(
      message,
      `Stripped ${removable.size} roles from ${target}.` +
      (kept ? ` Kept ${kept} that are above me or managed.` : ''),
    );
  },

  async role(message, args) {
    const sub = args[0]?.toLowerCase();

    if (sub === 'create') {
      const color = parseColor(args[1]);
      const name = args.slice(2).join(' ').trim();
      if (color === null || !name) {
        return say(message, 'Usage: `-role create <color> <name>`, e.g. `-role create #ff0000 Red Team`');
      }
      if (name.length > 100) return say(message, 'Role names max out at 100 characters.');
      const role = await message.guild.roles.create({
        name, color, reason: `role create ${by(message)}`,
      });
      return ok(message, `Created ${role}.`);
    }

    if (sub !== 'add' && sub !== 'remove') {
      return say(message, 'Usage: `-role add @user <role>`, `-role remove @user <role>`, `-role create <color> <name>`');
    }

    const target = await resolveMember(message.guild, args[1]);
    const role = resolveRole(message.guild, args.slice(2).join(' '));
    if (!target || !role) {
      return say(message, `Usage: \`-role ${sub} @user <role>\`. Role can be a mention, ID or name.`);
    }

    const problem = targetProblem(message, target, 'role') ?? roleProblem(message, role);
    if (problem) return say(message, problem);

    if (sub === 'add') {
      if (guildState(message.guildId).roleBans[target.id]?.includes(role.id)) {
        return say(message, `${target} is banned from ${role}. Use \`-roleunban\` first.`);
      }
      if (target.roles.cache.has(role.id)) return say(message, `${target} already has ${role}.`);
      await target.roles.add(role, `role add ${by(message)}`);
      return ok(message, `Gave ${role} to ${target}.`);
    }

    if (!target.roles.cache.has(role.id)) return say(message, `${target} doesn't have ${role}.`);
    await target.roles.remove(role, `role remove ${by(message)}`);
    return ok(message, `Removed ${role} from ${target}.`);
  },

  async roleban(message, args) {
    const target = await resolveMember(message.guild, args[0]);
    const role = resolveRole(message.guild, args.slice(1).join(' '));
    if (!target || !role) return say(message, 'Usage: `-roleban @user <role>`');

    const problem = targetProblem(message, target, 'roleban') ?? roleProblem(message, role);
    if (problem) return say(message, problem);

    const gs = guildState(message.guildId);
    const list = (gs.roleBans[target.id] ??= []);
    if (!list.includes(role.id)) list.push(role.id);
    save();

    if (target.roles.cache.has(role.id)) {
      await target.roles.remove(role, `role ban ${by(message)}`);
    }
    return ok(message, `${target} can no longer have ${role}.`);
  },

  async roleunban(message, args) {
    const target = await resolveMember(message.guild, args[0]);
    const role = resolveRole(message.guild, args.slice(1).join(' '));
    if (!target || !role) return say(message, 'Usage: `-roleunban @user <role>`');

    const gs = guildState(message.guildId);
    const list = gs.roleBans[target.id] ?? [];
    if (!list.includes(role.id)) return say(message, `${target} wasn't banned from ${role}.`);

    gs.roleBans[target.id] = list.filter((id) => id !== role.id);
    if (!gs.roleBans[target.id].length) delete gs.roleBans[target.id];
    save();
    return ok(message, `${target} can have ${role} again.`);
  },

  async rolebans(message, args) {
    const id = idFrom(args[0]);
    if (!id) return say(message, 'Usage: `-rolebans @user`');
    const list = guildState(message.guildId).roleBans[id] ?? [];
    if (!list.length) return info(message, `<@${id}> has no role bans.`);
    return info(message, `<@${id}> is banned from: ${list.map((r) => `<@&${r}>`).join(', ')}`);
  },

  async timeout(message, args) {
    const target = await resolveMember(message.guild, args[0]);
    if (!target) return say(message, 'Usage: `-timeout @user [10m] [reason]`');

    const parsed = parseDuration(args[1]);
    const ms = parsed ?? 10 * 60e3;
    const label = parsed ? args[1] : '10m';
    const reason = args.slice(parsed ? 2 : 1).join(' ');
    if (ms > MAX_TIMEOUT) return say(message, 'Max timeout is 28 days.');

    const problem = targetProblem(message, target, 'timeout');
    if (problem) return say(message, problem);
    if (!target.moderatable) {
      return say(message, "I can't time them out. They're an admin or above my role.");
    }

    await target.timeout(ms, reason ? `${reason} (${by(message)})` : by(message));
    return ok(message, `Timed out ${target} for ${label}.`);
  },

  async untimeout(message, args) {
    const target = await resolveMember(message.guild, args[0]);
    if (!target) return say(message, 'Usage: `-untimeout @user`');
    if (!target.isCommunicationDisabled()) return say(message, `${target} isn't timed out.`);
    await target.timeout(null, by(message));
    return ok(message, `Removed ${target}'s timeout.`);
  },

  async ban(message, args) {
    const id = idFrom(args[0]);
    if (!id) return say(message, 'Usage: `-ban @user|id [reason]`');
    const reason = args.slice(1).join(' ');

    if (id === message.client.user.id) return say(message, 'Not on me.');
    if (isSuper(id) && !isSuper(message.author.id)) {
      return say(message, "You can't use that on a bot admin.");
    }
    if (isImmune(id, message.guildId, 'ban')) {
      return say(message, `<@${id}> is whitelisted from \`-ban\`.`);
    }

    const member = await message.guild.members.fetch(id).catch(() => null);
    if (member) {
      const problem = targetProblem(message, member, 'ban');
      if (problem) return say(message, problem);
      if (!member.bannable) return say(message, "I can't ban them. They're above my role.");
    }

    await message.guild.members.ban(id, {
      reason: reason ? `${reason} (${by(message)})` : by(message),
    });
    return ok(message, `Banned <@${id}>.`);
  },

  async unban(message, args) {
    const id = idFrom(args[0]);
    if (!id) return say(message, 'Usage: `-unban <id>`');
    await message.guild.members.unban(id, by(message));
    return ok(message, `Unbanned <@${id}>.`);
  },

  async rt(message, args) {
    const gs = guildState(message.guildId);
    const sub = args[0]?.toLowerCase();
    const describe = (t) => (t.type === 'mention' ? `pings of <@${t.value}>` : `"${t.value}"`);

    if (sub === 'list') {
      if (!gs.reactions.length) return info(message, 'No auto reactions set.');
      return info(message, gs.reactions
        .map((t, i) => `${i + 1}. ${describe(t)} → ${t.emoji}`)
        .join('\n'));
    }

    if (sub === 'remove' || sub === 'delete') {
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n < 1 || n > gs.reactions.length) {
        return say(message, 'Usage: `-rt remove <number>` (see `-rt list`)');
      }
      const [removed] = gs.reactions.splice(n - 1, 1);
      save();
      return ok(message, `Removed ${describe(removed)} → ${removed.emoji}.`);
    }

    if (sub === 'clear') {
      gs.reactions = [];
      save();
      return ok(message, 'Cleared all auto reactions.');
    }

    const rest = sub === 'add' ? args.slice(1) : args;
    if (rest.length < 2) {
      return say(message, 'Usage: `-rt add @user <emoji>` or `-rt add <word or phrase> <emoji>`');
    }

    const emoji = rest[rest.length - 1];
    const triggerText = rest.slice(0, -1).join(' ');
    const mention = triggerText.match(/^<@!?(\d{17,20})>$/);
    const trigger = mention
      ? { type: 'mention', value: mention[1], emoji }
      : { type: 'phrase', value: triggerText.toLowerCase(), emoji };

    // Reacting to the command message checks the emoji is usable here.
    const usable = await message.react(emoji).then(() => true).catch(() => false);
    if (!usable) {
      return say(message, "I can't use that emoji. Use a default one or one from this server.");
    }

    const exists = gs.reactions.some((t) =>
      t.type === trigger.type && t.value === trigger.value && t.emoji === emoji);
    if (exists) return say(message, 'That auto reaction already exists.');

    gs.reactions.push(trigger);
    save();
    return ok(message, `Added: ${describe(trigger)} → ${emoji}`);
  },

  async alias(message, args) {
    const gs = guildState(message.guildId);
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      const lines = Object.entries({ ...BUILTIN_ALIASES, ...gs.aliases })
        .map(([a, c]) => `\`-${a}\` → \`-${c}\`${own(gs.aliases, a) ? '' : ' (built in)'}`);
      return info(message, lines.join('\n') || 'No aliases.');
    }

    if (sub === 'add') {
      const name = args[1]?.toLowerCase().replace(/^-+/, '');
      const target = resolveCommand(message.guildId, args[2]);
      if (!name || !target) return say(message, 'Usage: `-alias add <name> <command>`, e.g. `-alias add b ban`');
      if (!/^[a-z0-9_]{1,20}$/.test(name)) return say(message, 'Alias names are letters, numbers and _ only.');
      if (COMMANDS.includes(name) || INDEX_COMMANDS.includes(name) || own(BUILTIN_ALIASES, name)) {
        return say(message, `\`-${name}\` is already a command.`);
      }
      gs.aliases[name] = target;
      save();
      return ok(message, `\`-${name}\` now runs \`-${target}\`.`);
    }

    if (sub === 'remove' || sub === 'delete') {
      const name = args[1]?.toLowerCase().replace(/^-+/, '');
      if (!name || !own(gs.aliases, name)) return say(message, "That alias doesn't exist (built in ones can't be removed).");
      delete gs.aliases[name];
      save();
      return ok(message, `Removed \`-${name}\`.`);
    }

    return say(message, 'Usage: `-alias add <name> <command>`, `-alias remove <name>`, `-alias list`');
  },

  async snipeperms(message, args) {
    const gs = guildState(message.guildId);
    const userId = idFrom(args[0]);

    if (!userId) {
      const list = Object.keys(gs.snipers);
      return list.length
        ? info(message, `Snipe access: ${list.map((id) => `<@${id}>`).join(', ')}`)
        : info(message, 'Nobody has snipe access in this server.');
    }

    if (gs.snipers[userId]) {
      delete gs.snipers[userId];
      save();
      return ok(message, `<@${userId}> can no longer use the snipe commands.`);
    }

    gs.snipers[userId] = true;
    save();
    return ok(message, `<@${userId}> can now use \`-s\`, \`-es\` and \`-rs\`.`);
  },

  async whitelist(message, args) {
    const gs = guildState(message.guildId);
    const userId = idFrom(args.find((a) => idFrom(a)));

    if (!userId) {
      const entries = Object.entries(gs.immune);
      if (!entries.length) return info(message, 'Nobody is whitelisted in this server.');
      return info(message, entries.map(([id, list]) =>
        `<@${id}>: ${list.includes('all') ? 'everything' : list.map((c) => `\`-${c}\``).join(', ')}`,
      ).join('\n'));
    }

    const raw = args.filter((a) => !idFrom(a));
    const named = raw.map((a) => resolveCommand(message.guildId, a, { includeIndex: true }));
    const unknown = raw.filter((a, i) => !named[i]);
    if (unknown.length) return say(message, `Not a command: ${unknown.join(', ')}`);

    const current = gs.immune[userId] ?? [];
    gs.immune[userId] = named.length
      ? [...new Set([...current, ...named])]
      : ['all'];
    save();

    return ok(message, named.length
      ? `<@${userId}> is now whitelisted from ${named.map((c) => `\`-${c}\``).join(', ')}.`
      : `<@${userId}> is now whitelisted from everything.`);
  },

  async unwhitelist(message, args) {
    const gs = guildState(message.guildId);
    const userId = idFrom(args.find((a) => idFrom(a)));
    if (!userId) return say(message, 'Usage: `-unwhitelist @user [command...]`');

    const current = gs.immune[userId];
    if (!current?.length) return say(message, `<@${userId}> isn't whitelisted.`);

    const raw = args.filter((a) => !idFrom(a));
    const named = raw.map((a) => resolveCommand(message.guildId, a, { includeIndex: true }));
    const unknown = raw.filter((a, i) => !named[i]);
    if (unknown.length) return say(message, `Not a command: ${unknown.join(', ')}`);

    if (!named.length) {
      delete gs.immune[userId];
      save();
      return ok(message, `<@${userId}> is no longer whitelisted from anything.`);
    }

    const base = current.includes('all') ? [...COMMANDS, ...INDEX_COMMANDS] : current;
    const left = base.filter((c) => !named.includes(c));
    if (left.length) gs.immune[userId] = left;
    else delete gs.immune[userId];
    save();

    return ok(message, `<@${userId}> is no longer whitelisted from ${named.map((c) => `\`-${c}\``).join(', ')}.`);
  },

  async perms(message, args) {
    const gs = guildState(message.guildId);
    const flag = args.find((a) => a.startsWith('-'));
    const userId = idFrom(args.find((a) => idFrom(a)));

    if (!userId) {
      const entries = Object.entries(gs.perms);
      if (!entries.length) return info(message, 'Nobody has bot access in this server yet.');
      return info(message, entries.map(([id, e]) => {
        const denied = e.denied?.length
          ? ` (blocked: ${e.denied.map((c) => `-${c}`).join(', ')})`
          : '';
        return `<@${id}>${denied}`;
      }).join('\n'));
    }

    if (isSuper(userId)) return say(message, `<@${userId}> already has permanent access.`);

    if (flag) {
      const cmd = resolveCommand(message.guildId, flag, { includeIndex: true });
      if (!cmd) return say(message, `\`${flag}\` isn't a command.`);
      const entry = own(gs.perms, userId);
      if (!entry) return say(message, `<@${userId}> has no bot access here. Run \`-perms @user\` first.`);
      entry.denied = (entry.denied ?? []).filter((c) => c !== cmd);
      save();
      return ok(message, `<@${userId}> can use \`-${cmd}\` again.`);
    }

    gs.perms[userId] = { denied: [] };
    save();
    return ok(message, `<@${userId}> now has full bot access in this server.`);
  },

  async removeperm(message, args) {
    const gs = guildState(message.guildId);
    const flag = args.find((a) => a.startsWith('-'));
    const userId = idFrom(args.find((a) => idFrom(a)));
    if (!userId) return say(message, 'Usage: `-removeperm @user` or `-removeperm -<command> @user`');
    if (isSuper(userId)) return say(message, `<@${userId}> has permanent access and can't be removed.`);

    const entry = own(gs.perms, userId);
    if (!entry) return say(message, `<@${userId}> has no bot access here.`);

    if (flag) {
      const cmd = resolveCommand(message.guildId, flag, { includeIndex: true });
      if (!cmd) return say(message, `\`${flag}\` isn't a command.`);
      entry.denied = [...new Set([...(entry.denied ?? []), cmd])];
      save();
      return ok(message, `<@${userId}> can no longer use \`-${cmd}\`.`);
    }

    delete gs.perms[userId];
    save();
    return ok(message, `<@${userId}> no longer has bot access here.`);
  },
};

// ---------- forced english ----------
// Google's public gtx endpoint, no key needed.
const LANGS = new Intl.DisplayNames(['en'], { type: 'language' });

async function translate(text) {
  const url = 'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    console.error(`translate failed: HTTP ${response.status}`);
    return null;
  }

  const data = await response.json();
  const translated = (data[0] ?? []).map((part) => part[0] ?? '').join('').trim();
  return translated ? { text: translated, source: data[2] } : null;
}

async function runEnglish(message) {
  if (!state.guilds[message.guildId]?.english?.includes(message.channelId)) return;
  if (message.content.startsWith(PREFIX)) return;

  // Ignore mentions, emojis, links and anything too short to be a sentence.
  const stripped = message.content
    .replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+/g, ' ')
    .trim();
  if (stripped.replace(/[^\p{L}]/gu, '').length < 3) return;
  if (stripped.length > 1_000) return;

  const result = await translate(stripped).catch(() => null);
  if (!result || result.source === 'en') return;
  if (result.text.toLowerCase() === stripped.toLowerCase()) return;

  let language = result.source;
  try {
    language = LANGS.of(result.source) ?? result.source;
  } catch {
    // unknown code, keep it as is
  }

  await message.reply({
    content: `**${language}:** ${result.text}`.slice(0, 2000),
    allowedMentions: { parse: [], repliedUser: false },
  }).catch(() => {});
}

// ---------- auto reactions ----------
// Anyone saying w/l in this channel gets a thumbs up and thumbs down.
const WL_CHANNEL = '1551973120854855700';

async function runWl(message) {
  if (message.channelId !== WL_CHANNEL || !/w\/l/i.test(message.content)) return;
  await message.react('👍').catch(() => {});
  await message.react('👎').catch(() => {});
}

function runReactions(message) {
  const list = own(state.guilds, message.guildId)?.reactions;
  if (!list?.length) return;
  for (const trigger of list) {
    let hit;
    if (trigger.type === 'mention') {
      // A reply ping only counts for the three IDs above.
      hit = new RegExp(`<@!?${trigger.value}>`).test(message.content) ||
        (RT_REPLY_TARGETS.has(trigger.value) &&
          message.mentions.users.has(trigger.value));
    } else {
      hit = phraseRegex(trigger.value).test(message.content);
    }
    if (hit) message.react(trigger.emoji).catch(() => {});
  }
}

// ---------- entry points ----------

// Returns true if the message was one of this module's commands.
export async function handleMessage(message) {
  if (message.author.bot || !message.inGuild()) return false;

  const pet = own(own(state.guilds, message.guildId)?.pets, message.author.id);
  if (pet) {
    try {
      if (await petify(message, pet)) return true;
    } catch (error) {
      console.error(`petify failed: ${error.message}`);
    }
  }

  runWl(message);
  runEnglish(message);
  runReactions(message);

  if (!message.content.startsWith(PREFIX)) return false;
  const [head, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const name = resolveCommand(message.guildId, head);
  const phrase = name
    ? null
    : own(guildState(message.guildId).phrases, head.toLowerCase());
  if (phrase) {
    if (!canUse(message.author.id, message.guildId, 'say')) {
      await say(message, 'Not for you.');
      return true;
    }
    try {
      await speakOnce(message, args, phrase, head.toLowerCase());
    } catch (error) {
      await say(message, `That failed: ${error.message}`);
    }
    return true;
  }
  if (!name || !COMMANDS.includes(name)) return false;

  const allowed = canUse(message.author.id, message.guildId, name) ||
    (SNIPE_CMDS.has(name) && canSnipe(message.author.id, message.guildId));

  if (!allowed) {
    await say(message, SUPER_ONLY.has(name) ? 'Only bot admins can do that.' : 'Not for you.');
    return true;
  }

  try {
    await HANDLERS[name](message, args);
  } catch (error) {
    await say(message, `That failed: ${error.message}`);
  }
  return true;
}

// Enforces role bans when anything else hands out a banned role.
export function attach(client) {
  const enforce = async (member) => {
    const banned = own(own(state.guilds, member.guild.id)?.roleBans, member.id);
    if (!banned?.length) return;
    const hits = member.roles.cache.filter((r) => banned.includes(r.id));
    if (hits.size) await member.roles.remove(hits, 'role banned').catch(() => {});
  };

  // Puts a forced nickname back if they or another bot change it.
  const enforceNick = async (member) => {
    const locked = own(own(state.guilds, member.guild.id)?.nicks, member.id);
    if (!locked || member.nickname === locked) return;
    await member.setNickname(locked, 'forced nickname').catch(() => {});
  };

  client.on('guildMemberUpdate', (_old, member) => {
    enforce(member);
    enforceNick(member);
  });
  client.on('guildMemberAdd', async (member) => {
    const invite = await findInviter(member.guild);
    if (invite) {
      guildState(member.guild.id).invitedBy[member.id] = { ...invite, at: Date.now() };
      save();
    }
    sendGreeting(member, 'welcome', invite);
    setTimeout(() => enforce(member), 3_000);
    setTimeout(() => enforceNick(member), 3_000);
  });

  client.on('messageDelete', (message) => {
    if (!message.guild || message.author?.bot) return;
    if (!message.content && !message.attachments?.size) return;
    pushSnipe('delete', message.channelId, {
      userId: message.author.id,
      content: message.content,
      image: message.attachments.find((a) => a.contentType?.startsWith('image/'))?.url ?? null,
      at: Date.now(),
    });
  });

  client.on('messageUpdate', (before, after) => {
    if (!after.guild || after.author?.bot) return;
    if (!before.content || before.content === after.content) return;
    pushSnipe('edit', after.channelId, {
      userId: after.author.id,
      content: before.content,
      url: after.url,
      at: Date.now(),
    });
  });

  client.on('messageReactionRemove', (reaction, user) => {
    if (!reaction.message.guild || user.bot) return;
    pushSnipe('reaction', reaction.message.channelId, {
      userId: user.id,
      emoji: reaction.emoji.toString(),
      url: reaction.message.url,
      at: Date.now(),
    });
  });

  client.on('inviteCreate', (invite) => { cacheInvites(invite.guild); });
  client.on('inviteDelete', (invite) => { cacheInvites(invite.guild); });
  client.on('guildCreate', (guild) => { cacheInvites(guild); });
  client.on('guildMemberRemove', (member) => { sendGreeting(member, 'goodbye'); });

  // Lift timed image and reaction mutes.
  setInterval(async () => {
    for (const [guildId, gs] of Object.entries(state.guilds)) {
      const due = (gs.mutes ?? []).filter((m) => m.until <= Date.now());
      if (!due.length) continue;

      gs.mutes = gs.mutes.filter((m) => m.until > Date.now());
      save();

      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      for (const mute of due) {
        const roleId = gs.muteRoles?.[mute.kind];
        const member = roleId ? await guild.members.fetch(mute.userId).catch(() => null) : null;
        await member?.roles.remove(roleId, 'mute expired').catch(() => {});
      }
    }
  }, 30_000);

  // Leave events only fire for cached members, so cache everyone on start.
  client.once('clientReady', () => {
    for (const guild of client.guilds.cache.values()) {
      guild.members.fetch().catch(() => {});
      cacheInvites(guild);
    }
  });
}
