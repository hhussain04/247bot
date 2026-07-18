import fs from 'node:fs';
import os from 'node:os';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
} from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';

// ---------- config ----------
const TOKEN      = process.env.DISCORD_TOKEN;
const APP_ID     = process.env.APP_ID;
const GUILD_ID   = process.env.GUILD_ID;
const OWNER_ID   = process.env.OWNER_ID;
const LOG_FILE   = process.env.LOG_FILE || '/tmp/vcbot.log';
const STATE_FILE = new URL('./state.json', import.meta.url).pathname;

for (const [k, v] of Object.entries({ TOKEN, APP_ID, GUILD_ID, OWNER_ID })) {
  if (!v) { console.error(`missing env: ${k}`); process.exit(1); }
}

// channel id persists across restarts so /move survives a reboot
let channelId = process.env.CHANNEL_ID;
try { channelId = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).channelId ?? channelId; } catch {}
const saveState = () => {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ channelId })); } catch {}
};

// ---------- stats ----------
const startedAt = Date.now();
let reconnects = 0;
let lastReconnect = null;

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const fmtDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s % 60}s`);
  return parts.join(' ');
};

// ---------- voice ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

function connect() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) { log('guild not in cache — retrying in 10s'); setTimeout(connect, 10_000); return; }

  const conn = joinVoiceChannel({
    channelId,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: true,
  });

  conn.on(VoiceConnectionStatus.Ready, () => log(`voice ready in ${channelId}`));

  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // could just be a region move — give it a chance to resume itself
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      log('voice resumed after transient disconnect');
    } catch {
      reconnects++;
      lastReconnect = Date.now();
      log(`hard disconnect — rejoining (reconnect #${reconnects})`);
      conn.destroy();
      setTimeout(connect, 5_000);
    }
  });

  conn.on('error', (e) => log(`voice error: ${e.message}`));
  return conn;
}

// belt and braces: every 5 min, if we're not Ready, force a rejoin
setInterval(() => {
  const conn = getVoiceConnection(GUILD_ID);
  if (!conn || conn.state.status === VoiceConnectionStatus.Destroyed) {
    log('watchdog: no connection — reconnecting');
    reconnects++;
    lastReconnect = Date.now();
    connect();
  }
}, 5 * 60_000);

// ---------- slash commands ----------
const commands = [
  new SlashCommandBuilder().setName('status').setDescription('Full bot + voice connection status'),
  new SlashCommandBuilder().setName('uptime').setDescription('How long the bot has been running'),
  new SlashCommandBuilder().setName('ping').setDescription('Gateway latency'),
  new SlashCommandBuilder().setName('rejoin').setDescription('Force a voice reconnect'),
  new SlashCommandBuilder()
    .setName('logs').setDescription('Show the last N log lines')
    .addIntegerOption(o => o.setName('lines').setDescription('How many (1-40)').setMinValue(1).setMaxValue(40)),
  new SlashCommandBuilder()
    .setName('move').setDescription('Move the bot to another voice channel')
    .addChannelOption(o => o.setName('channel').setDescription('Target VC')
      .addChannelTypes(ChannelType.GuildVoice).setRequired(true)),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
  log(`registered ${commands.length} slash commands`);
}

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  if (i.user.id !== OWNER_ID) {
    return i.reply({ content: 'Not for you.', flags: MessageFlags.Ephemeral });
  }

  const conn = getVoiceConnection(GUILD_ID);
  const state = conn ? conn.state.status : 'none';

  try {
    switch (i.commandName) {
      case 'uptime':
        return i.reply(`Up **${fmtDuration(Date.now() - startedAt)}**`);

      case 'ping':
        return i.reply(`Gateway: **${Math.round(client.ws.ping)}ms**`);

      case 'status': {
        const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
        const load = os.loadavg()[0].toFixed(2);
        const ago = lastReconnect ? `${fmtDuration(Date.now() - lastReconnect)} ago` : 'never';
        return i.reply([
          `**Voice:** \`${state}\` in <#${channelId}>`,
          `**Uptime:** ${fmtDuration(Date.now() - startedAt)}`,
          `**Reconnects:** ${reconnects} (last: ${ago})`,
          `**Gateway:** ${Math.round(client.ws.ping)}ms`,
          `**Memory:** ${mem} MB · **Host load:** ${load}`,
        ].join('\n'));
      }

      case 'rejoin': {
        await i.deferReply();
        conn?.destroy();
        reconnects++;
        lastReconnect = Date.now();
        connect();
        return i.editReply('Reconnecting...');
      }

      case 'move': {
        const ch = i.options.getChannel('channel');
        await i.deferReply();
        conn?.destroy();
        channelId = ch.id;
        saveState();
        connect();
        return i.editReply(`Moved to <#${ch.id}>`);
      }

      case 'logs': {
        const n = i.options.getInteger('lines') ?? 15;
        let body;
        try {
          body = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-n).join('\n');
        } catch {
          return i.reply({ content: `Can't read \`${LOG_FILE}\``, flags: MessageFlags.Ephemeral });
        }
        if (!body) body = '(empty)';
        if (body.length > 1900) body = body.slice(-1900);
        return i.reply({ content: '```\n' + body + '\n```', flags: MessageFlags.Ephemeral });
      }
    }
  } catch (e) {
    log(`command error: ${e.message}`);
    if (!i.replied && !i.deferred) i.reply({ content: `Error: ${e.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ---------- boot ----------
client.once('clientReady', async () => {
  log(`logged in as ${client.user.tag}`);
  await registerCommands().catch(e => log(`command registration failed: ${e.message}`));
  connect();
});

process.on('unhandledRejection', e => log(`unhandledRejection: ${e?.message ?? e}`));
process.on('uncaughtException',  e => log(`uncaughtException: ${e?.message ?? e}`));

client.login(TOKEN);