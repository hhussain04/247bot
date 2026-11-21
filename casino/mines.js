const crypto = require('crypto');
const cfg = require('./config');
const store = require('./store');
const ui = require('./ui');
const { sleep, fmt, signed, parseAmount, emojiSet, jump } = require('./util');
const esp = require('./esp');

const { STYLE } = ui;
const busy = new Set(); // rounds mid-animation; extra clicks are ignored

// ---------- maths ----------

function multiplier(mines, picks) {
  if (picks <= 0) return 1;
  let m = 1;
  for (let i = 0; i < picks; i++) m *= (cfg.GRID - i) / (cfg.GRID - mines - i);
  return m * (1 - cfg.HOUSE_EDGE);
}
const payoutFor = (bet, mines, picks) => Math.floor(bet * multiplier(mines, picks));
const x = (n) => `${n.toFixed(2)}x`;

function placeBombs(mines) {
  const idx = [...Array(cfg.GRID).keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, mines).sort((a, b) => a - b);
}

function newId() {
  let id;
  do id = crypto.randomBytes(4).toString('hex');
  while (store.games[id]);
  return id;
}

function activeGameFor(guildId, userId) {
  return Object.values(store.games).find((g) => g.guildId === guildId && g.userId === userId && g.status === 'active');
}

// ---------- settling (all synchronous, money moves before any animation) ----------

function finish(game) {
  game.endedAt = Date.now();
  delete store.games[game.id];
  store.save();
}

function bust(game, idx) {
  const u = store.user(game.guildId, game.userId);
  game.status = 'busted';
  game.hit = idx;
  u.stats.played++;
  u.stats.lost++;
  u.stats.wagered += game.bet;
  u.stats.profit -= game.bet;
  finish(game);
}

function cashOut(game, reason) {
  const u = store.user(game.guildId, game.userId);
  const picks = game.revealed.length;
  const payout = payoutFor(game.bet, game.mines, picks);
  const multi = multiplier(game.mines, picks);
  u.balance += payout;
  u.stats.played++;
  u.stats.won++;
  u.stats.wagered += game.bet;
  u.stats.profit += payout - game.bet;
  u.stats.biggestWin = Math.max(u.stats.biggestWin, payout - game.bet);
  u.stats.bestMulti = Math.max(u.stats.bestMulti, Number(multi.toFixed(2)));
  game.status = 'cashed';
  game.payout = payout;
  game.reason = reason; // manual | clear | idle
  finish(game);
}

function refund(game) {
  store.user(game.guildId, game.userId).balance += game.bet;
  game.status = 'refunded';
  finish(game);
}

// ---------- rendering ----------

function tile(game, i, e, { pending, over, full }) {
  const id = `cas:t:${game.id}:${i}`;
  const picked = game.revealed.includes(i) && i !== pending;

  if (i === pending) return ui.button({ id, emoji: e.reveal.btn, style: STYLE.primary });
  if (!over) {
    if (picked) return ui.button({ id, emoji: e.safe.btn, style: STYLE.success });
    return ui.button({ id, emoji: e.hidden.btn, style: STYLE.secondary });
  }
  if (i === game.hit) return ui.button({ id, emoji: e.boom.btn, style: STYLE.danger, disabled: true });
  if (picked) return ui.button({ id, emoji: e.safe.btn, style: STYLE.success, disabled: true });
  if (!full) return ui.button({ id, emoji: e.hidden.btn, style: STYLE.secondary, disabled: true });
  if (game.bombs.includes(i)) return ui.button({ id, emoji: e.bomb.btn, style: STYLE.danger, disabled: true });
  return ui.button({ id, emoji: e.safe.btn, style: STYLE.secondary, disabled: true });
}

// pending: tile index shown mid-flip (round looks live until it lands)
// full: false keeps unpicked tiles hidden on the first end-of-round frame
function render(game, { pending = null, full = true } = {}) {
  const e = emojiSet(game.guildId);
  const over = game.status !== 'active' && pending === null;
  const safeTotal = cfg.GRID - game.mines;
  const picks = game.revealed.filter((i) => i !== pending).length;
  const multi = multiplier(game.mines, picks);
  const balance = store.user(game.guildId, game.userId).balance;
  const who = `<@${game.userId}>`;
  const footer = `-# ${picks}/${safeTotal} safe · ${game.mines} ${game.mines === 1 ? 'mine' : 'mines'} · Round \`${game.id}\``;

  let color, header, stats, controls;

  if (!over) {
    const next = multiplier(game.mines, picks + 1);
    const cashNow = payoutFor(game.bet, game.mines, picks);
    color = cfg.COLORS.play;
    header = `## ${e.bomb.txt} Mines\n${who} · Bet **${fmt(game.bet)}**`;
    stats = [
      `**Multiplier** \`${x(multi)}\` → next \`${x(next)}\``,
      picks > 0 ? `**Cash out** ${fmt(cashNow)} (${signed(cashNow - game.bet)})` : '**Cash out** pick a tile first',
      footer,
    ].join('\n');
    controls = ui.row(
      ui.button({
        id: `cas:co:${game.id}`,
        label: picks > 0 ? `Cash out ${fmt(cashNow)}` : 'Cash out',
        emoji: { name: '💰' },
        style: STYLE.success,
        disabled: picks === 0 || pending !== null,
      }),
      ui.button({ id: `cas:rnd:${game.id}`, label: 'Random tile', emoji: { name: '🎲' }, style: STYLE.secondary }),
    );
  } else {
    const profit = (game.payout ?? 0) - game.bet;
    if (game.status === 'busted') {
      color = cfg.COLORS.lose;
      header = `## ${e.boom.txt} Busted\n${who} hit a mine and lost **${fmt(game.bet)}**`;
      stats = `Got through **${picks}/${safeTotal}** tiles at \`${x(multi)}\`\n-# Balance ${fmt(balance)} · Round \`${game.id}\``;
    } else if (game.status === 'refunded') {
      color = cfg.COLORS.warn;
      header = `## ⏱️ Round expired\nNo tiles picked, so ${who} got **${fmt(game.bet)}** back`;
      stats = `-# Balance ${fmt(balance)} · Round \`${game.id}\``;
    } else {
      color = cfg.COLORS.win;
      const title = game.reason === 'clear' ? '🏆 Board cleared' : game.reason === 'idle' ? '⏱️ Auto cashed out' : '💰 Cashed out';
      header = `## ${title}\n${who} won **${fmt(game.payout)}** at \`${x(multi)}\` · ${signed(profit)}`;
      stats = `${game.reason === 'idle' ? 'Idle for a few minutes, so the round was cashed out for you\n' : ''}-# Balance ${fmt(balance)} · ${footer.slice(3)}`;
    }
    controls = ui.row(
      ui.button({
        id: `cas:again:${game.userId}:${game.bet}:${game.mines}`,
        label: `Play again · ${fmt(game.bet)}`,
        emoji: { name: '🔁' },
        style: STYLE.primary,
      }),
    );
  }

  const rows = [];
  for (let r = 0; r < 5; r++) {
    const btns = [];
    for (let c = 0; c < 5; c++) btns.push(tile(game, r * 5 + c, e, { pending, over, full }));
    rows.push(ui.row(...btns));
  }

  return ui.msg(ui.container(color, [ui.text(header), ui.sep(), ...rows, ui.sep(), ui.text(stats), controls]));
}

// Plays a list of [payload, delayAfterMs] frames on a button interaction
async function play(interaction, frames) {
  if (!cfg.ANIMATE) frames = frames.slice(-1);
  await interaction.update(frames[0][0]);
  for (let k = 1; k < frames.length; k++) {
    await sleep(frames[k - 1][1]);
    await interaction.editReply(frames[k][0]);
  }
}

// ---------- handlers ----------

async function start(interaction, betInput, mines) {
  const { guildId } = interaction;
  const userId = interaction.user.id;

  const existing = activeGameFor(guildId, userId);
  if (existing) {
    const where = existing.messageId ? ` ${jump(guildId, existing.channelId, existing.messageId)}` : '';
    return ui.notice(interaction, `You've already got a round going. Finish it first.${where}`);
  }

  const { config } = store.guild(guildId);
  const u = store.user(guildId, userId);
  const bet = parseAmount(betInput, u.balance);

  if (u.balance <= 0) return ui.notice(interaction, `You've got **${fmt(0)}**. Ask a bot admin to grant you some cash.`);
  if (!bet || bet < 1) return ui.notice(interaction, 'Enter a bet like `500`, `2.5k`, `half` or `all`.');
  if (config.minBet && bet < config.minBet) return ui.notice(interaction, `Minimum bet is **${fmt(config.minBet)}**.`);
  if (config.maxBet && bet > config.maxBet) return ui.notice(interaction, `Maximum bet is **${fmt(config.maxBet)}**.`);
  if (bet > u.balance) return ui.notice(interaction, `You only have **${fmt(u.balance)}**.`);

  u.balance -= bet;
  const now = Date.now();
  const game = {
    id: newId(),
    guildId,
    userId,
    channelId: interaction.channelId,
    messageId: null,
    bet,
    mines,
    bombs: placeBombs(mines),
    revealed: [],
    hit: null,
    status: 'active',
    createdAt: now,
    lastActionAt: now,
  };
  store.games[game.id] = game;
  store.save();

  let sent = false;
  try {
    await interaction.reply(render(game));
    sent = true;
    const reply = await interaction.fetchReply();
    game.channelId = reply.channelId;
    game.messageId = reply.id;
    store.save();
  } catch (err) {
    if (!sent && store.games[game.id]) {
      u.balance += bet;
      delete store.games[game.id];
      store.save();
    }
    throw err;
  }
  await esp.maybeShow(interaction, game);
}

async function guard(interaction, gameId) {
  const game = store.games[gameId];
  if (!game || game.status !== 'active') {
    await ui.notice(interaction, 'That round has already ended.');
    return null;
  }
  if (interaction.user.id !== game.userId) {
    await ui.notice(interaction, `This is <@${game.userId}>'s round. Start your own with \`/mines\`.`);
    return null;
  }
  if (busy.has(gameId)) {
    await interaction.deferUpdate();
    return null;
  }
  game.messageId ??= interaction.message?.id ?? null;
  game.channelId ??= interaction.channelId;
  return game;
}

async function reveal(interaction, game, idx) {
  if (game.revealed.includes(idx)) return interaction.deferUpdate();
  busy.add(game.id);
  try {
    game.lastActionAt = Date.now();
    if (game.bombs.includes(idx)) {
      bust(game, idx);
      return await play(interaction, [
        [render(game, { pending: idx }), cfg.SUSPENSE_MS],
        [render(game, { full: false }), cfg.CASCADE_MS],
        [render(game), 0],
      ]);
    }
    game.revealed.push(idx);
    if (game.revealed.length === cfg.GRID - game.mines) {
      cashOut(game, 'clear');
      return await play(interaction, [
        [render(game, { pending: idx }), cfg.SUSPENSE_MS],
        [render(game, { full: false }), cfg.CASCADE_MS],
        [render(game), 0],
      ]);
    }
    store.save();
    await play(interaction, [
      [render(game, { pending: idx }), cfg.SUSPENSE_MS],
      [render(game), 0],
    ]);
    return await esp.maybeShow(interaction, game);
  } finally {
    busy.delete(game.id);
  }
}

async function onTile(interaction, gameId, idx) {
  const game = await guard(interaction, gameId);
  if (game) await reveal(interaction, game, idx);
}

async function onRandom(interaction, gameId) {
  const game = await guard(interaction, gameId);
  if (!game) return;
  const hidden = [...Array(cfg.GRID).keys()].filter((i) => !game.revealed.includes(i));
  await reveal(interaction, game, hidden[crypto.randomInt(hidden.length)]);
}

async function onCashOut(interaction, gameId) {
  const game = await guard(interaction, gameId);
  if (!game) return;
  if (game.revealed.length === 0) return ui.notice(interaction, 'Pick at least one tile before cashing out.');
  busy.add(game.id);
  try {
    cashOut(game, 'manual');
    await play(interaction, [
      [render(game, { full: false }), cfg.CASCADE_MS],
      [render(game), 0],
    ]);
  } finally {
    busy.delete(game.id);
  }
}

async function onAgain(interaction, ownerId, bet, mines) {
  if (interaction.user.id !== ownerId) {
    return ui.notice(interaction, 'Start your own round with `/mines`.');
  }
  await start(interaction, String(bet), Number(mines));
}

// Auto-settle rounds nobody is clicking, so cash is never stuck in a dead round
async function sweep(client) {
  if (!client.isReady()) return;
  const now = Date.now();
  for (const game of Object.values(store.games)) {
    if (game.status !== 'active' || busy.has(game.id)) continue;
    if (now - game.lastActionAt < cfg.IDLE_MS) continue;
    if (game.revealed.length > 0) cashOut(game, 'idle');
    else refund(game);
    if (!game.messageId) continue;
    try {
      const channel = await client.channels.fetch(game.channelId);
      const message = await channel.messages.fetch(game.messageId);
      await message.edit(render(game));
    } catch (err) {
      console.warn(`[casino] settled idle round ${game.id} but could not edit its message:`, err.message);
    }
  }
}

module.exports = { multiplier, payoutFor, placeBombs, render, start, onTile, onRandom, onCashOut, onAgain, sweep, activeGameFor };
