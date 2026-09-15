import fs from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

import {
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';

import {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from '@discordjs/voice';

import * as football from './football.js';

// ---------- config ----------
const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.APP_ID;
const GUILD_ID = process.env.GUILD_ID;
const OWNER_ID = process.env.OWNER_ID;
const LOG_FILE = process.env.LOG_FILE || '/tmp/vcbot.log';
const STATE_FILE = new URL('./state.json', import.meta.url).pathname;

for (const [key, value] of Object.entries({
  TOKEN,
  APP_ID,
  GUILD_ID,
  OWNER_ID,
})) {
  if (!value) {
    console.error(`missing env: ${key}`);
    process.exit(1);
  }
}

// State persists across restarts.
let channelId = process.env.CHANNEL_ID;

const DEFAULT_MUZZLE_EMBED = Object.freeze({
  title: 'Message removed',
  description:
    '{user}, you are currently muzzled. Your messages will be deleted.',
  color: '#ED4245',
  footer: 'Messages from muzzled users are removed automatically.',
  thumbnail: '',
  image: '',
  noticeSeconds: 5,
});

let permittedUserIds = new Set();
let muzzledUserIds = new Set();
let muzzleEmbedConfig = { ...DEFAULT_MUZZLE_EMBED };

try {
  const savedState = JSON.parse(
    fs.readFileSync(STATE_FILE, 'utf8'),
  );

  channelId = savedState.channelId ?? channelId;

  if (Array.isArray(savedState.permittedUserIds)) {
    permittedUserIds = new Set(savedState.permittedUserIds);
  }

  if (Array.isArray(savedState.muzzledUserIds)) {
    muzzledUserIds = new Set(savedState.muzzledUserIds);
  }

  if (
    savedState.muzzleEmbedConfig &&
    typeof savedState.muzzleEmbedConfig === 'object'
  ) {
    muzzleEmbedConfig = {
      ...DEFAULT_MUZZLE_EMBED,
      ...savedState.muzzleEmbedConfig,
    };
  }
} catch {
  // No saved state yet.
}

if (!channelId) {
  console.error('missing env: CHANNEL_ID');
  process.exit(1);
}

const saveState = () => {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({
        channelId,
        permittedUserIds: [...permittedUserIds],
        muzzledUserIds: [...muzzledUserIds],
        muzzleEmbedConfig,
      }, null, 2),
    );
  } catch (error) {
    log(`failed to save state: ${error.message}`);
  }
};

// ---------- stats ----------
const startedAt = Date.now();

let reconnects = 0;
let lastReconnect = null;
let connectInProgress = false;

let disconnectedSince = null;
let disconnectAlertSent = false;

const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
};

const fmtDuration = (milliseconds) => {
  const seconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);

  parts.push(`${seconds % 60}s`);

  return parts.join(' ');
};

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, // privileged — enable Server Members Intent
  ],
});

// ---------- owner notification ----------
async function notifyOwner(message) {
  try {
    const owner = await client.users.fetch(OWNER_ID);
    await owner.send(message);
    log('sent disconnect notification to owner');
  } catch (error) {
    log(`failed to notify owner: ${error.message}`);
  }
}

// ---------- voice ----------
function isActuallyInVoice() {
  const guild = client.guilds.cache.get(GUILD_ID);

  return Boolean(
    guild?.members.me?.voice?.channelId &&
    guild.members.me.voice.channelId === channelId
  );
}

function destroyCurrentConnection() {
  const connection = getVoiceConnection(GUILD_ID);

  if (connection) {
    try {
      connection.destroy();
    } catch (error) {
      log(`connection destroy error: ${error.message}`);
    }
  }
}

async function connect({ force = false } = {}) {
  if (connectInProgress && !force) {
    log('connect already in progress');
    return null;
  }

  connectInProgress = true;

  try {
    const guild =
      client.guilds.cache.get(GUILD_ID) ??
      await client.guilds.fetch(GUILD_ID);

    const voiceChannel = await guild.channels.fetch(channelId);

    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error(`configured channel ${channelId} is not a voice channel`);
    }

    if (force) {
      destroyCurrentConnection();
    }

    const existing = getVoiceConnection(GUILD_ID);

    if (
      existing &&
      existing.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      return existing;
    }

    const connection = joinVoiceChannel({
      channelId,
      guildId: GUILD_ID,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true,
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      disconnectedSince = null;
      disconnectAlertSent = false;
      log(`voice ready in ${channelId}`);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      log('voice connection entered Disconnected state');

      try {
        await Promise.race([
          entersState(
            connection,
            VoiceConnectionStatus.Signalling,
            5_000,
          ),
          entersState(
            connection,
            VoiceConnectionStatus.Connecting,
            5_000,
          ),
        ]);

        log('voice resumed after transient disconnect');
      } catch {
        reconnects++;
        lastReconnect = Date.now();

        log(`hard disconnect — rejoining (reconnect #${reconnects})`);

        try {
          connection.destroy();
        } catch {
          // Already destroyed.
        }

        setTimeout(() => {
          connect().catch((error) => {
            log(`delayed reconnect failed: ${error.message}`);
          });
        }, 2_000);
      }
    });

    connection.on('error', (error) => {
      log(`voice error: ${error.message}`);
    });

    return connection;
  } catch (error) {
    log(`connect failed: ${error.message}`);

    setTimeout(() => {
      connect().catch((retryError) => {
        log(`connect retry failed: ${retryError.message}`);
      });
    }, 10_000);

    return null;
  } finally {
    connectInProgress = false;
  }
}

async function forceReconnect(reason = 'manual reconnect') {
  reconnects++;
  lastReconnect = Date.now();

  log(`${reason} (reconnect #${reconnects})`);

  destroyCurrentConnection();

  await new Promise((resolve) => setTimeout(resolve, 750));
  await connect({ force: true });
}

// Check frequently enough to detect a genuine ten-second absence.
setInterval(async () => {
  if (!client.isReady()) return;

  const inVoice = isActuallyInVoice();

  if (inVoice) {
    disconnectedSince = null;
    disconnectAlertSent = false;
    return;
  }

  if (!disconnectedSince) {
    disconnectedSince = Date.now();
    log('watchdog: bot is not in the configured voice channel');
  }

  const disconnectedFor = Date.now() - disconnectedSince;

  if (disconnectedFor >= 10_000 && !disconnectAlertSent) {
    disconnectAlertSent = true;

    await notifyOwner(
      [
        `<@${OWNER_ID}> the 24/7 bot has been outside its configured VC`,
        `<#${channelId}> for at least **10 seconds**.`,
        `I am attempting to reconnect automatically.`,
      ].join('\n'),
    );
  }

  const connection = getVoiceConnection(GUILD_ID);

  if (
    !connection ||
    connection.state.status === VoiceConnectionStatus.Destroyed
  ) {
    reconnects++;
    lastReconnect = Date.now();

    log(`watchdog reconnect attempt #${reconnects}`);

    await connect().catch((error) => {
      log(`watchdog reconnect failed: ${error.message}`);
    });
  }
}, 2_000);

// ---------- GIF helpers ----------
function getImageFromMessage(message) {
  const attachment = message.attachments.find((item) => {
    const contentType = item.contentType?.toLowerCase() ?? '';
    const name = item.name?.toLowerCase() ?? '';

    return (
      contentType.startsWith('image/') ||
      contentType === 'video/mp4' ||
      /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|mp4)$/i.test(name)
    );
  });

  if (attachment) {
    return {
      url: attachment.url,
      name: attachment.name ?? 'image',
      contentType: attachment.contentType ?? '',
    };
  }

  const embedImage = message.embeds.find((embed) => {
    return embed.image?.url || embed.thumbnail?.url;
  });

  if (embedImage) {
    return {
      url: embedImage.image?.url ?? embedImage.thumbnail.url,
      name: 'embed-image',
      contentType: 'image/unknown',
    };
  }

  return null;
}

async function resolveGifSource(commandMessage) {
  // First priority: image in the message being replied to.
  if (commandMessage.reference?.messageId) {
    try {
      const repliedMessage = await commandMessage.channel.messages.fetch(
        commandMessage.reference.messageId,
      );

      const image = getImageFromMessage(repliedMessage);

      if (image) return image;
    } catch (error) {
      log(`could not fetch replied message: ${error.message}`);
    }
  }

  // Second priority: most recently sent image before the command.
  const recentMessages = await commandMessage.channel.messages.fetch({
    limit: 50,
    before: commandMessage.id,
  });

  const orderedMessages = [...recentMessages.values()].sort(
    (a, b) => b.createdTimestamp - a.createdTimestamp,
  );

  for (const message of orderedMessages) {
    const image = getImageFromMessage(message);

    if (image) return image;
  }

  return null;
}

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 30;

async function downloadMedia(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(
      `media download failed with HTTP ${response.status}`,
    );
  }

  const declaredLength = Number(
    response.headers.get('content-length') ?? 0,
  );

  if (declaredLength > MAX_INPUT_BYTES) {
    throw new Error('file is larger than 20 MB');
  }

  const input = Buffer.from(await response.arrayBuffer());

  if (input.length > MAX_INPUT_BYTES) {
    throw new Error('file is larger than 20 MB');
  }

  return {
    input,
    contentType:
      response.headers.get('content-type')?.toLowerCase() ?? '',
  };
}

function isMp4Source(source, downloadedContentType) {
  const sourceContentType =
    source.contentType?.toLowerCase().split(';')[0] ?? '';

  const responseContentType =
    downloadedContentType.toLowerCase().split(';')[0];

  return (
    sourceContentType === 'video/mp4' ||
    responseContentType === 'video/mp4' ||
    /\.mp4$/i.test(source.name ?? '')
  );
}

function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const filter = [
      "[0:v]fps=12,scale='min(480,iw)':-2:flags=lanczos,split[s0][s1]",
      '[s0]palettegen=max_colors=128:stats_mode=diff[p]',
      '[s1][p]paletteuse=dither=sierra2_4a[out]',
    ].join(';');

    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-t',
      String(MAX_VIDEO_SECONDS),
      '-filter_complex',
      filter,
      '-map',
      '[out]',
      '-an',
      '-loop',
      '0',
      '-fs',
      String(MAX_OUTPUT_BYTES),
      outputPath,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    let settled = false;

    const finish = (error = null) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);

      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        new Error('MP4 conversion timed out after 60 seconds'),
      );
    }, 60_000);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();

      if (stderr.length > 4_000) {
        stderr = stderr.slice(-4_000);
      }
    });

    child.on('error', (error) => {
      finish(
        new Error(`could not start FFmpeg: ${error.message}`),
      );
    });

    child.on('close', (code) => {
      if (code === 0) {
        finish();
        return;
      }

      const detail =
        stderr.trim().slice(-1_000) || `exit code ${code}`;

      finish(new Error(`FFmpeg failed: ${detail}`));
    });
  });
}

async function convertMp4ToGif(input) {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'vcbot-gif-'),
  );

  const inputPath = path.join(tempDirectory, 'input.mp4');
  const outputPath = path.join(tempDirectory, 'output.gif');

  try {
    await writeFile(inputPath, input);
    await runFfmpeg(inputPath, outputPath);

    const outputInfo = await stat(outputPath);

    if (outputInfo.size === 0) {
      throw new Error('FFmpeg created an empty GIF');
    }

    if (outputInfo.size >= MAX_OUTPUT_BYTES - 1_024) {
      throw new Error(
        'generated GIF is too large; use a shorter or smaller MP4',
      );
    }

    return await readFile(outputPath);
  } finally {
    await rm(tempDirectory, {
      recursive: true,
      force: true,
    }).catch(() => {});
  }
}

async function convertToGif(source) {
  const downloaded = await downloadMedia(source.url);

  if (isMp4Source(source, downloaded.contentType)) {
    return convertMp4ToGif(downloaded.input);
  }

  const gif = await sharp(downloaded.input, {
    animated: true,
    limitInputPixels: 100_000_000,
  })
    .rotate()
    .gif({
      effort: 3,
      colours: 256,
    })
    .toBuffer();

  if (gif.length > MAX_OUTPUT_BYTES) {
    throw new Error('generated GIF is larger than 24 MB');
  }

  return gif;
}

// ---------- muzzle helpers ----------
const muzzleNoticeCooldowns = new Map();

function renderMuzzleText(template, user, guild) {
  return String(template)
    .replaceAll('{user}', `<@${user.id}>`)
    .replaceAll('{username}', user.username)
    .replaceAll('{server}', guild?.name ?? 'this server');
}

function normalizeEmbedColor(value) {
  const cleaned = value.trim().toUpperCase();
  const normalized = cleaned.startsWith('#')
    ? cleaned
    : `#${cleaned}`;

  if (!/^#[0-9A-F]{6}$/.test(normalized)) {
    throw new Error(
      'Color must be a six-digit hex color, such as #ED4245.',
    );
  }

  return normalized;
}

function normalizeEmbedUrl(value) {
  if (value.trim().toLowerCase() === 'none') {
    return '';
  }

  const parsed = new URL(value);

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Embed URLs must use http:// or https://.');
  }

  return parsed.toString();
}

function buildMuzzleEmbed(user, guild) {
  const color = Number.parseInt(
    muzzleEmbedConfig.color.replace('#', ''),
    16,
  );

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(
      renderMuzzleText(
        muzzleEmbedConfig.title,
        user,
        guild,
      ),
    )
    .setDescription(
      renderMuzzleText(
        muzzleEmbedConfig.description,
        user,
        guild,
      ),
    )
    .setTimestamp();

  if (muzzleEmbedConfig.footer) {
    embed.setFooter({
      text: renderMuzzleText(
        muzzleEmbedConfig.footer,
        user,
        guild,
      ),
    });
  }

  if (muzzleEmbedConfig.thumbnail) {
    embed.setThumbnail(muzzleEmbedConfig.thumbnail);
  }

  if (muzzleEmbedConfig.image) {
    embed.setImage(muzzleEmbedConfig.image);
  }

  return embed;
}

async function resolveMuzzleTarget(message) {
  const mentionedUser = message.mentions.users.first();

  if (mentionedUser) {
    return mentionedUser;
  }

  const token = message.content.trim().split(/\s+/)[1];
  const possibleId = token?.replace(/[<@!>]/g, '');

  if (!possibleId || !/^\d{17,20}$/.test(possibleId)) {
    return null;
  }

  return client.users.fetch(possibleId).catch(() => null);
}

async function sendMuzzleNotice(message) {
  const cooldownKey =
    `${message.channel.id}:${message.author.id}`;

  if (muzzleNoticeCooldowns.has(cooldownKey)) {
    return;
  }

  muzzleNoticeCooldowns.set(cooldownKey, Date.now());

  const cooldownTimer = setTimeout(() => {
    muzzleNoticeCooldowns.delete(cooldownKey);
  }, 5_000);

  cooldownTimer.unref();

  try {
    const notice = await message.channel.send({
      embeds: [
        buildMuzzleEmbed(message.author, message.guild),
      ],
    });

    const noticeSeconds = Number(
      muzzleEmbedConfig.noticeSeconds,
    );

    if (Number.isInteger(noticeSeconds) && noticeSeconds > 0) {
      const deleteTimer = setTimeout(() => {
        notice.delete().catch(() => {});
      }, noticeSeconds * 1_000);

      deleteTimer.unref();
    }
  } catch (error) {
    log(`failed to send muzzle embed: ${error.message}`);
  }
}

// ---------- text commands ----------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.inGuild()) return;

  if (muzzledUserIds.has(message.author.id)) {
    try {
      await message.delete();
      log(`deleted message from muzzled user ${message.author.id}`);
      await sendMuzzleNotice(message);
    } catch (error) {
      log(
        `failed to delete muzzled message from ` +
        `${message.author.id}: ${error.message}`,
      );
    }

    return;
  }

  const command = message.content.trim().toLowerCase();

  const isMuzzleCommand =
    command === '-muzzle' ||
    command.startsWith('-muzzle ') ||
    command === '-unmuzzle' ||
    command.startsWith('-unmuzzle ');

  const isKnownTextCommand =
    command === '-reconnect' ||
    command === '-gif' ||
    isMuzzleCommand;

  if (!isKnownTextCommand) return;

  const isOwner = message.author.id === OWNER_ID;
  const hasBotPermission =
    isOwner || permittedUserIds.has(message.author.id);

  if (!hasBotPermission) {
    await message.reply('Not for you.').catch(() => {});
    return;
  }

  if (isMuzzleCommand && !isOwner) {
    await message.reply(
      'Only the bot owner can manage muzzles.',
    ).catch(() => {});

    return;
  }

  if (
    command === '-muzzle' ||
    command.startsWith('-muzzle ')
  ) {
    const target = await resolveMuzzleTarget(message);

    if (!target) {
      await message.reply(
        'Usage: `-muzzle @user`',
      ).catch(() => {});

      return;
    }

    if (target.id === OWNER_ID) {
      await message.reply(
        'The bot owner cannot be muzzled.',
      ).catch(() => {});

      return;
    }

    if (target.bot) {
      await message.reply(
        'Bots cannot be muzzled.',
      ).catch(() => {});

      return;
    }

    const alreadyMuzzled = muzzledUserIds.has(target.id);

    muzzledUserIds.add(target.id);
    saveState();

    await message.reply({
      content: alreadyMuzzled
        ? `${target} was already muzzled.`
        : `${target} is now muzzled.`,
      embeds: [buildMuzzleEmbed(target, message.guild)],
      allowedMentions: { parse: [] },
    }).catch((error) => {
      log(`failed to confirm muzzle: ${error.message}`);
    });

    return;
  }

  if (
    command === '-unmuzzle' ||
    command.startsWith('-unmuzzle ')
  ) {
    const target = await resolveMuzzleTarget(message);

    if (!target) {
      await message.reply(
        'Usage: `-unmuzzle @user`',
      ).catch(() => {});

      return;
    }

    const wasMuzzled = muzzledUserIds.delete(target.id);
    saveState();

    await message.reply(
      wasMuzzled
        ? `${target} is no longer muzzled.`
        : `${target} was not muzzled.`,
      {
        allowedMentions: { parse: [] },
      },
    ).catch(() => {});

    return;
  }

  if (command === '-reconnect') {
    const reply = await message.reply('Reconnecting...');

    try {
      await forceReconnect('owner used -reconnect');
      await reply.edit(`Reconnected to <#${channelId}>.`);
    } catch (error) {
      log(`-reconnect failed: ${error.message}`);
      await reply.edit(`Reconnect failed: ${error.message}`);
    }

    return;
  }

  if (command === '-gif') {
    const progress = await message.reply('Finding the image or MP4...');

    try {
      const source = await resolveGifSource(message);

      if (!source) {
        await progress.edit(
          'Reply to an image or MP4 with `-gif`, or send `-gif` after one.',
        );
        return;
      }

      await progress.edit('Converting it to GIF...');

      const gif = await convertToGif(source);

      const file = new AttachmentBuilder(gif, {
        name: `favourite-${Date.now()}.gif`,
        description: 'Converted to GIF',
      });

      await message.reply({
        content: 'Click the star on this GIF to add it to your favourites.',
        files: [file],
      });

      await progress.delete().catch(() => {});
    } catch (error) {
      log(`-gif failed: ${error.message}`);

      await progress.edit(
        `Could not convert that image: ${error.message}`,
      );
    }
  }
});

// ---------- slash commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Full bot + voice connection status'),

  new SlashCommandBuilder()
    .setName('uptime')
    .setDescription('How long the bot has been running'),

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Gateway latency'),

  new SlashCommandBuilder()
    .setName('rejoin')
    .setDescription('Force a voice reconnect'),

  new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Show the last N log lines')
    .addIntegerOption((option) =>
      option
        .setName('lines')
        .setDescription('How many lines, from 1 to 40')
        .setMinValue(1)
        .setMaxValue(40),
    ),

  new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move the bot to another voice channel')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Target VC')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('perms')
    .setDescription('Grant, revoke, or list bot access')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription(
          'User to grant or revoke access for; omit to list',
        ),
    )
    .addBooleanOption((option) =>
      option
        .setName('allow')
        .setDescription(
          'True grants access; false revokes it',
        ),
    ),

  new SlashCommandBuilder()
    .setName('muzzleembed')
    .setDescription('Customize the muzzle notification embed')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('set')
        .setDescription('Update the muzzle embed')
        .addStringOption((option) =>
          option
            .setName('title')
            .setDescription(
              'Embed title; supports {user}, {username}, {server}',
            )
            .setMinLength(1)
            .setMaxLength(256),
        )
        .addStringOption((option) =>
          option
            .setName('description')
            .setDescription(
              'Embed text; supports {user}, {username}, {server}',
            )
            .setMinLength(1)
            .setMaxLength(4000),
        )
        .addStringOption((option) =>
          option
            .setName('color')
            .setDescription('Hex color, for example #ED4245')
            .setMinLength(6)
            .setMaxLength(7),
        )
        .addStringOption((option) =>
          option
            .setName('footer')
            .setDescription(
              'Footer text, or "none" to remove it',
            )
            .setMaxLength(2000),
        )
        .addStringOption((option) =>
          option
            .setName('thumbnail_url')
            .setDescription(
              'Thumbnail URL, or "none" to remove it',
            )
            .setMaxLength(1000),
        )
        .addStringOption((option) =>
          option
            .setName('image_url')
            .setDescription(
              'Large image URL, or "none" to remove it',
            )
            .setMaxLength(1000),
        )
        .addIntegerOption((option) =>
          option
            .setName('notice_seconds')
            .setDescription(
              'Seconds before notice disappears; 0 keeps it',
            )
            .setMinValue(0)
            .setMaxValue(60),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('preview')
        .setDescription('Preview the current muzzle embed'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('reset')
        .setDescription('Reset the muzzle embed to defaults'),
    ),

].map((command) => command.toJSON());

const allCommands = [...commands, ...football.commands];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(APP_ID, GUILD_ID),
    { body: allCommands },
  );

  log(
    `registered ${allCommands.length} slash commands ` +
    `(${football.commands.length} from football)`,
  );
}

client.on('interactionCreate', async (interaction) => {
  // football runs first: it does its own permission checks, and it needs
  // button and modal interactions from ordinary members, which the two
  // guards below would otherwise discard
  try {
    if (await football.handle(interaction)) return;
  } catch (error) {
    log(`football error: ${error.message}`);
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({
        content: `Error: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const isOwner = interaction.user.id === OWNER_ID;
  const hasBotPermission =
    isOwner || permittedUserIds.has(interaction.user.id);

  if (!hasBotPermission) {
    return interaction.reply({
      content: 'Not for you.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const isOwnerOnlyCommand =
    interaction.commandName === 'perms' ||
    interaction.commandName === 'muzzleembed';

  if (isOwnerOnlyCommand && !isOwner) {
    return interaction.reply({
      content: 'Only the bot owner can use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const connection = getVoiceConnection(GUILD_ID);
  const state = connection?.state.status ?? 'none';

  try {
    switch (interaction.commandName) {
      case 'uptime':
        return interaction.reply(
          `Up **${fmtDuration(Date.now() - startedAt)}**`,
        );

      case 'ping':
        return interaction.reply(
          `Gateway: **${Math.round(client.ws.ping)}ms**`,
        );

      case 'status': {
        const memory = (
          process.memoryUsage().rss /
          1024 /
          1024
        ).toFixed(0);

        const load = os.loadavg()[0].toFixed(2);

        const lastReconnectText = lastReconnect
          ? `${fmtDuration(Date.now() - lastReconnect)} ago`
          : 'never';

        return interaction.reply([
          `**Voice:** \`${state}\` in <#${channelId}>`,
          `**Actually in VC:** ${isActuallyInVoice() ? 'yes' : 'no'}`,
          `**Uptime:** ${fmtDuration(Date.now() - startedAt)}`,
          `**Reconnects:** ${reconnects} (last: ${lastReconnectText})`,
          `**Gateway:** ${Math.round(client.ws.ping)}ms`,
          `**Memory:** ${memory} MB · **Host load:** ${load}`,
        ].join('\n'));
      }

      case 'rejoin': {
        await interaction.deferReply();

        await forceReconnect('owner used /rejoin');

        return interaction.editReply(
          `Reconnected to <#${channelId}>.`,
        );
      }

      case 'move': {
        const targetChannel =
          interaction.options.getChannel('channel');

        await interaction.deferReply();

        destroyCurrentConnection();

        channelId = targetChannel.id;
        saveState();

        disconnectedSince = Date.now();
        disconnectAlertSent = false;

        await connect({ force: true });

        return interaction.editReply(
          `Moved to <#${targetChannel.id}>`,
        );
      }

      case 'perms': {
        const target = interaction.options.getUser('user');
        const allow =
          interaction.options.getBoolean('allow') ?? true;

        if (!target) {
          const permittedUsers = [...permittedUserIds];

          const content = permittedUsers.length
            ? [
                '**Users with bot access:**',
                ...permittedUsers.map(
                  (userId) => `• <@${userId}> (\`${userId}\`)`,
                ),
              ].join('\n')
            : 'No additional users currently have bot access.';

          return interaction.reply({
            content,
            allowedMentions: { parse: [] },
            flags: MessageFlags.Ephemeral,
          });
        }

        if (target.id === OWNER_ID) {
          return interaction.reply({
            content: 'The owner already has permanent access.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (target.bot) {
          return interaction.reply({
            content: 'Bot accounts cannot be granted access.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (allow) {
          permittedUserIds.add(target.id);
          saveState();

          return interaction.reply({
            content:
              `${target} can now use the bot's normal commands.`,
            allowedMentions: { parse: [] },
            flags: MessageFlags.Ephemeral,
          });
        }

        const removed = permittedUserIds.delete(target.id);
        saveState();

        return interaction.reply({
          content: removed
            ? `${target} no longer has bot access.`
            : `${target} did not have bot access.`,
          allowedMentions: { parse: [] },
          flags: MessageFlags.Ephemeral,
        });
      }

      case 'muzzleembed': {
        const action = interaction.options.getSubcommand();

        if (action === 'preview') {
          return interaction.reply({
            embeds: [
              buildMuzzleEmbed(
                interaction.user,
                interaction.guild,
              ),
            ],
            flags: MessageFlags.Ephemeral,
          });
        }

        if (action === 'reset') {
          muzzleEmbedConfig = {
            ...DEFAULT_MUZZLE_EMBED,
          };

          saveState();

          return interaction.reply({
            content: 'Muzzle embed reset to defaults.',
            embeds: [
              buildMuzzleEmbed(
                interaction.user,
                interaction.guild,
              ),
            ],
            flags: MessageFlags.Ephemeral,
          });
        }

        const title =
          interaction.options.getString('title');

        const description =
          interaction.options.getString('description');

        const color =
          interaction.options.getString('color');

        const footer =
          interaction.options.getString('footer');

        const thumbnailUrl =
          interaction.options.getString('thumbnail_url');

        const imageUrl =
          interaction.options.getString('image_url');

        const noticeSeconds =
          interaction.options.getInteger('notice_seconds');

        const hasChange = [
          title,
          description,
          color,
          footer,
          thumbnailUrl,
          imageUrl,
          noticeSeconds,
        ].some((value) => value !== null);

        if (!hasChange) {
          return interaction.reply({
            content:
              'Choose at least one embed setting to change.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const nextConfig = {
          ...muzzleEmbedConfig,
        };

        if (title !== null) {
          nextConfig.title = title;
        }

        if (description !== null) {
          nextConfig.description = description;
        }

        if (color !== null) {
          nextConfig.color = normalizeEmbedColor(color);
        }

        if (footer !== null) {
          nextConfig.footer =
            footer.toLowerCase() === 'none' ? '' : footer;
        }

        if (thumbnailUrl !== null) {
          nextConfig.thumbnail =
            normalizeEmbedUrl(thumbnailUrl);
        }

        if (imageUrl !== null) {
          nextConfig.image = normalizeEmbedUrl(imageUrl);
        }

        if (noticeSeconds !== null) {
          nextConfig.noticeSeconds = noticeSeconds;
        }

        muzzleEmbedConfig = nextConfig;
        saveState();

        return interaction.reply({
          content: 'Muzzle embed updated.',
          embeds: [
            buildMuzzleEmbed(
              interaction.user,
              interaction.guild,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }

      case 'logs': {
        const lineCount =
          interaction.options.getInteger('lines') ?? 15;

        let body;

        try {
          body = fs
            .readFileSync(LOG_FILE, 'utf8')
            .trim()
            .split('\n')
            .slice(-lineCount)
            .join('\n');
        } catch {
          return interaction.reply({
            content: `Can't read \`${LOG_FILE}\``,
            flags: MessageFlags.Ephemeral,
          });
        }

        if (!body) body = '(empty)';
        if (body.length > 1900) body = body.slice(-1900);

        return interaction.reply({
          content: `\`\`\`\n${body}\n\`\`\``,
          flags: MessageFlags.Ephemeral,
        });
      }

      default:
        return null;
    }
  } catch (error) {
    log(`command error: ${error.message}`);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(
        `Error: ${error.message}`,
      ).catch(() => {});
    } else {
      await interaction.reply({
        content: `Error: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    return null;
  }
});

// ---------- boot ----------
client.once('clientReady', async () => {
  log(`logged in as ${client.user.tag}`);

  await registerCommands().catch((error) => {
    log(`command registration failed: ${error.message}`);
  });

  await connect();
});

process.on('unhandledRejection', (error) => {
  log(`unhandledRejection: ${error?.message ?? error}`);
});

process.on('uncaughtException', (error) => {
  log(`uncaughtException: ${error?.message ?? error}`);
});

client.login(TOKEN);
