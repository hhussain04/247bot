const cfg = require('./config');
const store = require('./store');
const ui = require('./ui');
const { fmt, ts, isAdmin, log } = require('./util');

const { STYLE } = ui;

function shop(guildId, userId) {
  const g = store.guild(guildId);
  const { balance } = store.user(guildId, userId);
  const parts = [ui.text(`## 🎁 Redeem\nYou have **${fmt(balance)}**. Pick a reward and a bot admin will hand it over.`), ui.sep()];

  if (!g.config.redeemChannelId) {
    parts.push(ui.text('Redeeming is switched off until an admin sets a redeem channel with `/cashadmin settings`.'));
  } else if (!g.rewards.length) {
    parts.push(ui.text('No rewards yet. Admins can add some with `/cashadmin reward-add`.'));
  } else {
    for (const r of g.rewards) {
      const soldOut = r.stock === 0;
      const stock = r.stock == null ? '' : soldOut ? ' · sold out' : ` · ${r.stock} left`;
      const desc = r.description ? `${r.description}${stock}` : stock.replace(/^ · /, '');
      parts.push(
        ui.section(
          [`**${r.name}** · ${fmt(r.cost)}${desc ? `\n-# ${desc}` : ''}`],
          ui.button({
            id: `cas:rd:pick:${r.id}`,
            label: soldOut ? 'Sold out' : balance < r.cost ? `Need ${fmt(r.cost - balance)}` : 'Redeem',
            style: STYLE.primary,
            disabled: soldOut || balance < r.cost,
          }),
        ),
      );
    }
  }
  return ui.container(cfg.COLORS.shop, parts);
}

async function open(interaction) {
  return interaction.reply(ui.msg(shop(interaction.guildId, interaction.user.id), { ephemeral: true }));
}

async function pick(interaction, rewardId) {
  const reward = store.guild(interaction.guildId).rewards.find((r) => r.id === rewardId);
  if (!reward) return interaction.update(ui.msg(shop(interaction.guildId, interaction.user.id)));
  const { balance } = store.user(interaction.guildId, interaction.user.id);
  const box = ui.container(cfg.COLORS.shop, [
    ui.text(`## Confirm redeem\n**${reward.name}** for **${fmt(reward.cost)}**\nBalance after: **${fmt(balance - reward.cost)}**`),
    ui.text('-# The cash is taken now. If an admin denies it, you get it back.'),
    ui.row(
      ui.button({ id: `cas:rd:ok:${reward.id}`, label: 'Confirm', emoji: { name: '✅' }, style: STYLE.success, disabled: balance < reward.cost }),
      ui.button({ id: 'cas:rd:back', label: 'Back', style: STYLE.secondary }),
    ),
  ]);
  return interaction.update(ui.msg(box));
}

function requestCard(req) {
  const color = req.status === 'pending' ? cfg.COLORS.warn : req.status === 'given' ? cfg.COLORS.win : cfg.COLORS.lose;
  const status =
    req.status === 'pending'
      ? '⏳ Waiting for an admin'
      : req.status === 'given'
        ? `✅ Given by <@${req.handledBy}> ${ts(req.handledAt)}`
        : `↩️ Denied by <@${req.handledBy}> ${ts(req.handledAt)}, cash refunded`;
  const parts = [
    ui.text(`## 🎁 Redeem \`${req.id}\``),
    ui.text(
      [
        `**Member** <@${req.userId}> · \`${req.userId}\``,
        `**Reward** ${req.rewardName}`,
        `**Paid** ${fmt(req.cost)}`,
        `**Requested** ${ts(req.createdAt)}`,
        `**Status** ${status}`,
      ].join('\n'),
    ),
  ];
  if (req.status === 'pending') {
    parts.push(
      ui.sep(),
      ui.row(
        ui.button({ id: `cas:rd:done:${req.id}`, label: 'Mark as given', emoji: { name: '✅' }, style: STYLE.success }),
        ui.button({ id: `cas:rd:deny:${req.id}`, label: 'Deny and refund', emoji: { name: '↩️' }, style: STYLE.danger }),
      ),
    );
  }
  return ui.container(color, parts);
}

const confirming = new Set(); // stops a double click making two requests

async function confirm(interaction, rewardId) {
  const lock = interaction.message?.id || interaction.user.id;
  if (confirming.has(lock)) return interaction.deferUpdate();
  confirming.add(lock);
  try {
    return await confirmInner(interaction, rewardId);
  } finally {
    confirming.delete(lock);
  }
}

async function confirmInner(interaction, rewardId) {
  const g = store.guild(interaction.guildId);
  const u = store.user(interaction.guildId, interaction.user.id);
  const reward = g.rewards.find((r) => r.id === rewardId);

  if (!reward) return interaction.update(ui.msg(shop(interaction.guildId, interaction.user.id)));
  if (!g.config.redeemChannelId) return ui.notice(interaction, 'Redeeming is switched off right now.');
  if (reward.stock === 0) return ui.notice(interaction, 'That reward just sold out.');
  if (u.balance < reward.cost) return ui.notice(interaction, `You need **${fmt(reward.cost)}** and have **${fmt(u.balance)}**.`);

  // Take the cash and stock first, put them back if the admin post fails
  u.balance -= reward.cost;
  if (reward.stock != null) reward.stock--;
  g.redeemSeq++;
  const req = {
    id: `R-${String(g.redeemSeq).padStart(4, '0')}`,
    userId: interaction.user.id,
    rewardId: reward.id,
    rewardName: reward.name,
    cost: reward.cost,
    status: 'pending',
    createdAt: Date.now(),
    channelId: g.config.redeemChannelId,
    messageId: null,
  };
  g.redeems[req.id] = req;
  store.save();

  try {
    const channel = await interaction.client.channels.fetch(req.channelId);
    const posted = await channel.send(ui.msg(requestCard(req)));
    req.messageId = posted.id;
    store.save();
  } catch (err) {
    u.balance += reward.cost;
    if (reward.stock != null) reward.stock++;
    delete g.redeems[req.id];
    store.save();
    console.warn('[casino] redeem post failed:', err.message);
    return ui.notice(interaction, "Couldn't reach the redeem channel, so nothing was taken. Tell an admin to check the bot can post there.");
  }

  await log(interaction.client, interaction.guildId, `🎁 <@${req.userId}> redeemed **${req.rewardName}** for ${fmt(req.cost)} (\`${req.id}\`)`);

  const box = ui.container(cfg.COLORS.win, [
    ui.text(`## ✅ Request sent\n**${reward.name}** for **${fmt(reward.cost)}** · \`${req.id}\`\nAn admin will sort it out. You'll get a DM when it's done.`),
    ui.text(`-# Balance ${fmt(u.balance)}`),
  ]);
  return interaction.update(ui.msg(box));
}

async function handle(interaction, reqId, outcome) {
  if (!isAdmin(interaction)) return ui.notice(interaction, 'Only casino admins can handle redeem requests.');
  const g = store.guild(interaction.guildId);
  const req = g.redeems[reqId];
  if (!req) return ui.notice(interaction, "That request doesn't exist any more.");
  if (req.status !== 'pending') return interaction.update(ui.msg(requestCard(req)));

  req.status = outcome;
  req.handledBy = interaction.user.id;
  req.handledAt = Date.now();
  if (outcome === 'denied') {
    store.user(interaction.guildId, req.userId).balance += req.cost;
    const reward = g.rewards.find((r) => r.id === req.rewardId);
    if (reward && reward.stock != null) reward.stock++;
  }
  store.save();

  await interaction.update(ui.msg(requestCard(req)));

  const where = interaction.guild?.name ? ` in **${interaction.guild.name}**` : '';
  const dm =
    outcome === 'given'
      ? `✅ Your redeem \`${req.id}\` for **${req.rewardName}**${where} has been given to you.`
      : `↩️ Your redeem \`${req.id}\` for **${req.rewardName}**${where} was denied. **${fmt(req.cost)}** went back to your balance.`;
  try {
    const member = await interaction.client.users.fetch(req.userId);
    await member.send(dm);
  } catch {
    // DMs closed, nothing to do
  }
  await log(interaction.client, interaction.guildId, `${outcome === 'given' ? '✅' : '↩️'} <@${interaction.user.id}> ${outcome === 'given' ? 'gave' : 'denied'} \`${req.id}\` (${req.rewardName}) for <@${req.userId}>`);
}

async function back(interaction) {
  return interaction.update(ui.msg(shop(interaction.guildId, interaction.user.id)));
}

module.exports = { open, pick, confirm, handle, back };
