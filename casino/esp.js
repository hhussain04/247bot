// /casinoesp: lets a player see where the mines are, in a private message only they can see.
// Only the IDs in config OWNER_IDS (you + the full-perms users) can turn it on or off.
const cfg = require('./config');
const store = require('./store');
const ui = require('./ui');
const { emojiSet } = require('./util');

const allowed = (interaction) => cfg.OWNER_IDS.includes(interaction.user.id);
const hasEsp = (guildId, userId) => Boolean(store.guild(guildId).esp[userId]);

async function command(interaction) {
  if (!allowed(interaction)) return ui.notice(interaction, "You can't use this.");
  const g = store.guild(interaction.guildId);
  const target = interaction.options.getUser('user');

  if (!target) {
    const ids = Object.keys(g.esp);
    return ui.notice(interaction, ids.length ? `ESP is on for: ${ids.map((id) => `<@${id}>`).join(', ')}` : 'Nobody has ESP in this server.');
  }

  const on = interaction.options.getBoolean('on') ?? !g.esp[target.id];
  if (on) g.esp[target.id] = true;
  else delete g.esp[target.id];
  store.save();

  return ui.notice(
    interaction,
    on
      ? `ESP **on** for <@${target.id}>. They'll get a private mine map when their next round starts, or on their next click if they're mid-round.`
      : `ESP **off** for <@${target.id}>.`,
  );
}

// Sends the private mine map once per round, if the player has ESP
async function maybeShow(interaction, game) {
  if (game.espSent || game.status !== 'active' || !hasEsp(game.guildId, game.userId)) return;
  if (interaction.user.id !== game.userId) return;
  game.espSent = true;
  store.save();

  const e = emojiSet(game.guildId);
  const lines = [];
  for (let r = 0; r < 5; r++) {
    let line = '';
    for (let c = 0; c < 5; c++) line += game.bombs.includes(r * 5 + c) ? e.bomb.txt : e.safe.txt;
    lines.push(line);
  }
  const box = ui.container(0x2b2d31, [
    ui.text(`## 🔮 Mine map\n-# Only you can see this · Round \`${game.id}\``),
    ui.sep(),
    ui.text(lines.join('\n')),
  ]);
  try {
    await interaction.followUp(ui.msg(box, { ephemeral: true }));
  } catch (err) {
    console.warn('[casino] esp map failed:', err.message);
  }
}

module.exports = { command, maybeShow };
