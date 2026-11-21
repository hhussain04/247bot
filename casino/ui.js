// Raw Components V2 helpers (needs discord.js 14.19 or newer)
const IS_V2 = 1 << 15;
const EPHEMERAL = 1 << 6;

const STYLE = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };

const text = (content) => ({ type: 10, content });
const sep = (divider = true, spacing = 1) => ({ type: 14, divider, spacing });
const row = (...components) => ({ type: 1, components });
const container = (color, components) => ({ type: 17, accent_color: color, components });
const section = (lines, accessory) => ({ type: 9, components: lines.map(text), accessory });

function button({ id, url, label, emoji, style = STYLE.secondary, disabled = false }) {
  const b = { type: 2, style: url ? STYLE.link : style, disabled };
  if (url) b.url = url;
  else b.custom_id = id;
  if (label) b.label = label;
  if (emoji) b.emoji = emoji;
  return b;
}

// Full message payload. Pass ephemeral only on first reply, never on update/edit.
function msg(box, { ephemeral = false, mentionUsers = [] } = {}) {
  return {
    flags: IS_V2 | (ephemeral ? EPHEMERAL : 0),
    components: [box],
    allowedMentions: { parse: [], users: mentionUsers },
  };
}

// Plain ephemeral notice, for errors and quick replies
async function notice(interaction, content) {
  const payload = { content, flags: EPHEMERAL, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

module.exports = { IS_V2, EPHEMERAL, STYLE, text, sep, row, container, section, button, msg, notice };
