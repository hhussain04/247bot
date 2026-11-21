const { SlashCommandBuilder, ChannelType, InteractionContextType, PermissionFlagsBits } = require('discord.js');

function serverOnly(builder) {
  if (typeof builder.setContexts === 'function' && InteractionContextType) builder.setContexts(InteractionContextType.Guild);
  else builder.setDMPermission(false);
  return builder;
}

const mines = serverOnly(
  new SlashCommandBuilder()
    .setName('mines')
    .setDescription('Play Mines with your cash')
    .addStringOption((o) => o.setName('bet').setDescription('How much to bet: 500, 2.5k, half, all').setRequired(true).setMaxLength(20))
    .addIntegerOption((o) => o.setName('mines').setDescription('How many mines on the board (1-24, default 3)').setMinValue(1).setMaxValue(24)),
);

const cash = serverOnly(
  new SlashCommandBuilder()
    .setName('cash')
    .setDescription('Balances, stats and the leaderboard')
    .addSubcommand((s) =>
      s.setName('balance').setDescription('Check a balance').addUserOption((o) => o.setName('user').setDescription('Whose balance (default: you)')),
    )
    .addSubcommand((s) => s.setName('leaderboard').setDescription('Richest players in this server'))
    .addSubcommand((s) =>
      s.setName('stats').setDescription('Mines stats').addUserOption((o) => o.setName('user').setDescription('Whose stats (default: you)')),
    ),
);

const redeem = serverOnly(new SlashCommandBuilder().setName('redeem').setDescription('Spend your cash on rewards'));

const amount = (o) => o.setName('amount').setDescription('Amount, e.g. 500, 10k, 1.5m').setRequired(true).setMaxLength(20);
const target = (o) => o.setName('user').setDescription('Who').setRequired(true);
const reason = (o) => o.setName('reason').setDescription('Shown in the log').setMaxLength(100);

const cashadmin = serverOnly(
  new SlashCommandBuilder()
    .setName('cashadmin')
    .setDescription('Casino admin tools')
    .addSubcommand((s) => s.setName('grant').setDescription('Give someone cash').addUserOption(target).addStringOption(amount).addStringOption(reason))
    .addSubcommand((s) => s.setName('take').setDescription('Take cash from someone').addUserOption(target).addStringOption(amount).addStringOption(reason))
    .addSubcommand((s) => s.setName('set').setDescription("Set someone's exact balance").addUserOption(target).addStringOption(amount))
    .addSubcommand((s) =>
      s
        .setName('settings')
        .setDescription('Admin role, redeem channel, log channel, bet limits')
        .addRoleOption((o) => o.setName('admin-role').setDescription('Role that can grant cash and handle redeems'))
        .addChannelOption((o) =>
          o.setName('redeem-channel').setDescription('Where redeem requests get posted for admins').addChannelTypes(ChannelType.GuildText),
        )
        .addChannelOption((o) => o.setName('log-channel').setDescription('Where grants and redeems get logged').addChannelTypes(ChannelType.GuildText))
        .addIntegerOption((o) => o.setName('min-bet').setDescription('Smallest bet allowed (0 = no minimum)').setMinValue(0))
        .addIntegerOption((o) => o.setName('max-bet').setDescription('Biggest bet allowed (0 = no limit)').setMinValue(0))
        .addBooleanOption((o) => o.setName('clear-admin-role').setDescription('Remove the admin role')),
    )
    .addSubcommand((s) =>
      s
        .setName('emojis')
        .setDescription('Change the Mines emojis (paste unicode or server emojis)')
        .addStringOption((o) => o.setName('safe').setDescription('Safe tile (default ✅)').setMaxLength(80))
        .addStringOption((o) => o.setName('bomb').setDescription('Mine (default 💣)').setMaxLength(80))
        .addStringOption((o) => o.setName('explosion').setDescription('The mine you hit (default 💥)').setMaxLength(80))
        .addStringOption((o) => o.setName('hidden').setDescription('Unrevealed tile (default ❔)').setMaxLength(80))
        .addStringOption((o) => o.setName('reveal').setDescription('Tile mid-flip (default ✨)').setMaxLength(80))
        .addBooleanOption((o) => o.setName('reset').setDescription('Go back to the defaults first')),
    )
    .addSubcommand((s) =>
      s
        .setName('reward-add')
        .setDescription('Add a reward people can redeem')
        .addStringOption((o) => o.setName('name').setDescription('e.g. Nitro Basic, VIP role, 1v1 with the owner').setRequired(true).setMaxLength(60))
        .addStringOption((o) => o.setName('cost').setDescription('Price, e.g. 50k').setRequired(true).setMaxLength(20))
        .addStringOption((o) => o.setName('description').setDescription('Short description').setMaxLength(100))
        .addIntegerOption((o) => o.setName('stock').setDescription('How many can be redeemed (leave empty for unlimited)').setMinValue(0)),
    )
    .addSubcommand((s) =>
      s
        .setName('reward-remove')
        .setDescription('Remove a reward')
        .addStringOption((o) => o.setName('reward').setDescription('Which reward').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('pending').setDescription('List redeem requests waiting for an admin')),
);

// Hidden from non-admins. Only the IDs in config OWNER_IDS can actually use it.
const casinoesp = serverOnly(
  new SlashCommandBuilder()
    .setName('casinoesp')
    .setDescription('Toggle the mine map for a player')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((o) => o.setName('user').setDescription('Who (leave empty to list who has it)'))
    .addBooleanOption((o) => o.setName('on').setDescription('On or off (default: flip it)')),
);

const builders = [mines, cash, redeem, cashadmin, casinoesp];

module.exports = {
  builders,
  json: builders.map((b) => b.toJSON()),
  names: new Set(builders.map((b) => b.name)),
};
