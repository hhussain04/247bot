const path = require('path');

module.exports = {
  // Shown before every amount, e.g. $1,250
  CURRENCY: '$',

  // Mines board (5x5). Don't change unless you also change the grid layout.
  GRID: 25,

  // Payout cut per round. 0.01 = 1% (same as Stake). Set 0 for a "fair" game.
  HOUSE_EDGE: 0.01,

  // A round with no clicks for this long is auto cashed out (or refunded if no tiles picked)
  IDLE_MS: 3 * 60 * 1000,

  // Reveal animations. Turn off if your bot is in a lot of busy servers.
  ANIMATE: true,
  SUSPENSE_MS: 300, // how long a tile "flips" before showing what's under it
  CASCADE_MS: 550,  // delay between end-of-round reveal frames

  // Defaults. Admins can override per server with /cashadmin emojis
  // Custom emoji format: <:name:id> or <a:name:id> for animated
  DEFAULT_EMOJIS: {
    safe: '✅',
    bomb: '💣',
    boom: '💥',
    hidden: '❔',
    reveal: '✨',
  },

  COLORS: {
    play: 0x5865f2,
    win: 0x57f287,
    lose: 0xed4245,
    warn: 0xfee75c,
    shop: 0xeb459e,
  },

  MAX_REWARDS: 10,

  // Where balances, rewards and redeem requests are stored. Keep this out of git.
  DATA_FILE: process.env.CASINO_DATA || path.join(__dirname, '..', 'casino-data.json'),

  // Bot owners always count as casino admins. Reads OWNER_ID or OWNER_IDS (comma separated) from .env
  OWNER_IDS: (process.env.OWNER_IDS || process.env.OWNER_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
