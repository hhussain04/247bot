const cfg = require('./config');
const store = require('./store');
const ui = require('./ui');
const { fmt, signed, parseAmount, parseEmoji, emojiSet, canConfigure, isAdmin, log } = require('./util');

const { STYLE } = ui;

// ---------- /cash ----------

async function balance(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const u = store.user(interaction.guildId, target.id);
  const self = target.id === interaction.user.id;
  const box = ui.container(cfg.COLORS.play, [
    ui.text(`## 💵 ${fmt(u.balance)}\n${self ? 'Your balance' : `<@${target.id}>'s balance`}`),
    ui.text(`-# Play with \`/mines\` · spend it with \`/redeem\``),
  ]);
  return interaction.reply(ui.msg(box));
}

async function leaderboard(interaction) {
  const { users } = store.guild(interaction.guildId);
  const top = Object.entries(users)
    .filter(([, u]) => u.balance > 0)
    .sort((a, b) => b[1].balance - a[1].balance)
    .slice(0, 10);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.length
    ? top.map(([id, u], i) => `${medals[i] || `\`${String(i + 1).padStart(2, ' ')}\``} <@${id}> · **${fmt(u.balance)}**`).join('\n')
    : 'Nobody has any cash yet.';
  const box = ui.container(cfg.COLORS.warn, [ui.text('## 🏆 Richest players'), ui.sep(), ui.text(lines)]);
  return interaction.reply(ui.msg(box));
}

async function stats(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const u = store.user(interaction.guildId, target.id);
  const s = u.stats;
  const rate = s.played ? Math.round((s.won / s.played) * 100) : 0;
  const box = ui.container(cfg.COLORS.play, [
    ui.text(`## 📊 Mines stats\n<@${target.id}>`),
    ui.sep(),
    ui.text(
      [
        `**Balance** ${fmt(u.balance)}`,
        `**Rounds** ${s.played} · **Won** ${s.won} · **Lost** ${s.lost} (${rate}% cashed out)`,
        `**Wagered** ${fmt(s.wagered)} · **Net** ${signed(s.profit)}`,
        `**Biggest win** ${fmt(s.biggestWin)} · **Best multiplier** \`${(s.bestMulti || 0).toFixed(2)}x\``,
      ].join('\n'),
    ),
  ]);
  return interaction.reply(ui.msg(box));
}

// ---------- /cashadmin ----------

async function grant(interaction, mode) {
  const target = interaction.options.getUser('user');
  const amount = parseAmount(interaction.options.getString('amount'));
  const reason = interaction.options.getString('reason');
  if (target.bot) return ui.notice(interaction, "Bots can't hold cash.");
  if (amount == null || (mode !== 'set' && amount < 1)) return ui.notice(interaction, 'Enter an amount like `500`, `10k` or `1.5m`.');

  const u = store.user(interaction.guildId, target.id);
  const before = u.balance;
  if (mode === 'grant') u.balance += amount;
  if (mode === 'take') u.balance = Math.max(0, u.balance - amount);
  if (mode === 'set') u.balance = amount;
  store.save();

  const change = u.balance - before;
  const why = reason ? `\n-# Reason: ${reason}` : '';
  await log(
    interaction.client,
    interaction.guildId,
    `🧾 <@${interaction.user.id}> ${mode === 'set' ? 'set' : mode === 'grant' ? 'granted' : 'took'} ${signed(change)} → <@${target.id}> (now ${fmt(u.balance)})${reason ? ` · ${reason}` : ''}`,
  );

  if (mode === 'grant') {
    const box = ui.container(cfg.COLORS.win, [
      ui.text(`## 💸 +${fmt(change)}\n<@${interaction.user.id}> gave <@${target.id}> **${fmt(change)}**. New balance **${fmt(u.balance)}**.${why}`),
    ]);
    return interaction.reply(ui.msg(box, { mentionUsers: [target.id] }));
  }
  return ui.notice(interaction, `<@${target.id}>: ${fmt(before)} → **${fmt(u.balance)}** (${signed(change)})`);
}

function settingsSummary(guildId) {
  const c = store.guild(guildId).config;
  return [
    `**Admin role** ${c.adminRoleId ? `<@&${c.adminRoleId}>` : 'none (Manage Server only)'}`,
    `**Redeem channel** ${c.redeemChannelId ? `<#${c.redeemChannelId}>` : 'not set, /redeem is off'}`,
    `**Log channel** ${c.logChannelId ? `<#${c.logChannelId}>` : 'not set'}`,
    `**Min bet** ${c.minBet ? fmt(c.minBet) : 'none'} · **Max bet** ${c.maxBet ? fmt(c.maxBet) : 'none'}`,
  ].join('\n');
}

async function settings(interaction) {
  if (!canConfigure(interaction)) return ui.notice(interaction, 'Only the bot owner or people with Manage Server can change casino settings.');
  const o = interaction.options;
  const c = store.guild(interaction.guildId).config;
  const role = o.getRole('admin-role');
  const redeemCh = o.getChannel('redeem-channel');
  const logCh = o.getChannel('log-channel');
  const minBet = o.getInteger('min-bet');
  const maxBet = o.getInteger('max-bet');

  if (role) c.adminRoleId = role.id;
  if (o.getBoolean('clear-admin-role')) delete c.adminRoleId;
  if (redeemCh) c.redeemChannelId = redeemCh.id;
  if (logCh) c.logChannelId = logCh.id;
  if (minBet != null) c.minBet = minBet;
  if (maxBet != null) c.maxBet = maxBet;
  store.save();

  const box = ui.container(cfg.COLORS.play, [ui.text('## ⚙️ Casino settings'), ui.sep(), ui.text(settingsSummary(interaction.guildId))]);
  return interaction.reply(ui.msg(box, { ephemeral: true }));
}

async function emojis(interaction) {
  if (!canConfigure(interaction)) return ui.notice(interaction, 'Only the bot owner or people with Manage Server can change the emojis.');
  const o = interaction.options;
  const c = store.guild(interaction.guildId).config;
  const previous = { ...c.emojis };

  if (o.getBoolean('reset')) c.emojis = {};
  const fields = { safe: 'safe', bomb: 'bomb', explosion: 'boom', hidden: 'hidden', reveal: 'reveal' };
  for (const [option, key] of Object.entries(fields)) {
    const value = o.getString(option);
    if (!value) continue;
    if (!parseEmoji(value)) return ui.notice(interaction, `\`${value}\` isn't an emoji. Paste the emoji itself, like 💎 or a server emoji.`);
    c.emojis[key] = value.trim();
  }

  const e = emojiSet(interaction.guildId);
  const preview = ['hidden', 'reveal', 'safe', 'bomb', 'boom'].map((k, i) =>
    ui.button({ id: `cas:noop:${i}`, emoji: e[k].btn, style: [2, 1, 3, 4, 4][i], disabled: true }),
  );
  const box = ui.container(cfg.COLORS.play, [
    ui.text('## 🎨 Mines emojis\nhidden · flipping · safe · mine · hit'),
    ui.row(...preview),
    ui.text('-# Custom emojis must be from a server the bot is in, or uploaded as app emojis in the Developer Portal.'),
  ]);

  try {
    await interaction.reply(ui.msg(box, { ephemeral: true }));
    store.save();
  } catch (err) {
    c.emojis = previous; // Discord rejected one of them, keep the old set
    return ui.notice(interaction, "Discord rejected one of those emojis, so nothing changed. If it's a custom emoji, the bot has to be in the server it comes from.");
  }
}

async function rewardAdd(interaction) {
  const g = store.guild(interaction.guildId);
  if (g.rewards.length >= cfg.MAX_REWARDS) return ui.notice(interaction, `You can have up to ${cfg.MAX_REWARDS} rewards. Remove one first.`);
  const cost = parseAmount(interaction.options.getString('cost'));
  if (!cost || cost < 1) return ui.notice(interaction, 'Enter a cost like `5000` or `50k`.');
  const reward = {
    id: Math.random().toString(36).slice(2, 8),
    name: interaction.options.getString('name').trim(),
    cost,
    description: interaction.options.getString('description')?.trim() || '',
    stock: interaction.options.getInteger('stock'), // null = unlimited
  };
  g.rewards.push(reward);
  store.save();
  return ui.notice(interaction, `Added **${reward.name}** for **${fmt(cost)}**${reward.stock != null ? ` (${reward.stock} in stock)` : ''}.${g.config.redeemChannelId ? '' : '\nSet a redeem channel with `/cashadmin settings` so people can use `/redeem`.'}`);
}

async function rewardRemove(interaction) {
  const g = store.guild(interaction.guildId);
  const id = interaction.options.getString('reward');
  const i = g.rewards.findIndex((r) => r.id === id || r.name.toLowerCase() === id.toLowerCase());
  if (i === -1) return ui.notice(interaction, "Couldn't find that reward.");
  const [removed] = g.rewards.splice(i, 1);
  store.save();
  return ui.notice(interaction, `Removed **${removed.name}**. Pending requests for it are unaffected.`);
}

async function pending(interaction) {
  const g = store.guild(interaction.guildId);
  const list = Object.values(g.redeems)
    .filter((r) => r.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, 15);
  const lines = list.length
    ? list
        .map((r) => {
          const link = r.messageId ? ` · [open](https://discord.com/channels/${interaction.guildId}/${r.channelId}/${r.messageId})` : '';
          return `\`${r.id}\` <@${r.userId}> · ${r.rewardName} · ${fmt(r.cost)}${link}`;
        })
        .join('\n')
    : 'No pending requests.';
  const box = ui.container(cfg.COLORS.shop, [ui.text('## 🎁 Pending redeems'), ui.sep(), ui.text(lines)]);
  return interaction.reply(ui.msg(box, { ephemeral: true }));
}

async function autocomplete(interaction) {
  const focused = String(interaction.options.getFocused() || '').toLowerCase();
  const { rewards } = store.guild(interaction.guildId);
  const choices = rewards
    .filter((r) => r.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((r) => ({ name: `${r.name} · ${fmt(r.cost)}`.slice(0, 100), value: r.id }));
  return interaction.respond(choices);
}

async function admin(interaction) {
  if (!isAdmin(interaction)) return ui.notice(interaction, "You're not a casino admin here.");
  const sub = interaction.options.getSubcommand();
  if (sub === 'grant' || sub === 'take' || sub === 'set') return grant(interaction, sub);
  if (sub === 'settings') return settings(interaction);
  if (sub === 'emojis') return emojis(interaction);
  if (sub === 'reward-add') return rewardAdd(interaction);
  if (sub === 'reward-remove') return rewardRemove(interaction);
  if (sub === 'pending') return pending(interaction);
}

async function cash(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'balance') return balance(interaction);
  if (sub === 'leaderboard') return leaderboard(interaction);
  if (sub === 'stats') return stats(interaction);
}

module.exports = { cash, admin, autocomplete, STYLE };
