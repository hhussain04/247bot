// Casino module: /mines, /cash, /redeem, /cashadmin
//
// Wire-up in your main bot file:
//   const casino = require('./casino');
//   casino.setup(client);                       // once, after creating the client
//   ...commands: [...yourCommands, ...casino.commands]   // wherever you register slash commands
//   if (casino.handles(interaction)) return;    // first line of your own interactionCreate handler

const { version } = require('discord.js');
const store = require('./store');
const ui = require('./ui');
const commands = require('./commands');
const mines = require('./mines');
const economy = require('./economy');
const redeem = require('./redeem');

function handles(interaction) {
  if (interaction.isChatInputCommand?.() || interaction.isAutocomplete?.()) return commands.names.has(interaction.commandName);
  if (interaction.isMessageComponent?.()) return interaction.customId.startsWith('cas:');
  return false;
}

async function route(interaction) {
  if (!interaction.inGuild()) return ui.notice(interaction, 'The casino only works in servers.');

  if (interaction.isAutocomplete()) return economy.autocomplete(interaction);

  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {
      case 'mines':
        return mines.start(interaction, interaction.options.getString('bet'), interaction.options.getInteger('mines') ?? 3);
      case 'cash':
        return economy.cash(interaction);
      case 'redeem':
        return redeem.open(interaction);
      case 'cashadmin':
        return economy.admin(interaction);
    }
    return;
  }

  // Buttons. IDs look like cas:<kind>:<args...>
  const [, kind, a, b, c] = interaction.customId.split(':');
  switch (kind) {
    case 't':
      return mines.onTile(interaction, a, Number(b));
    case 'co':
      return mines.onCashOut(interaction, a);
    case 'rnd':
      return mines.onRandom(interaction, a);
    case 'again':
      return mines.onAgain(interaction, a, Number(b), Number(c));
    case 'rd':
      if (a === 'pick') return redeem.pick(interaction, b);
      if (a === 'ok') return redeem.confirm(interaction, b);
      if (a === 'back') return redeem.back(interaction);
      if (a === 'done') return redeem.handle(interaction, b, 'given');
      if (a === 'deny') return redeem.handle(interaction, b, 'denied');
  }
  return interaction.deferUpdate();
}

function setup(client) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 14 || (major === 14 && minor < 19)) {
    console.warn(`[casino] discord.js ${version} is too old for the Mines layout. Run: npm i discord.js@14`);
  }
  store.load();

  client.on('interactionCreate', (interaction) => {
    if (!handles(interaction)) return;
    route(interaction).catch(async (err) => {
      console.error('[casino]', interaction.customId || interaction.commandName, err);
      if (interaction.isAutocomplete()) return;
      try {
        await ui.notice(interaction, 'Something went wrong with that. Try again in a moment.');
      } catch {}
    });
  });

  // Settle idle rounds (also catches rounds left open across a restart)
  const timer = setInterval(() => mines.sweep(client).catch((e) => console.error('[casino] sweep', e)), 20_000);
  timer.unref?.();
}

module.exports = { setup, handles, commands: commands.json };
