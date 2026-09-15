// football.js — trial applications + position picker for the 247 bot.
//
// ES module, matching index.js. Import it with:
//   import * as football from './football.js';
//
// Commands:
//   /apply      post the application panel (Manage Roles)
//   /positions  post the position picker panel (Manage Roles)
//   /syncnames  re-apply (POS) suffixes to everyone (Manage Nicknames)

import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js';

// --- config ----------------------------------------------------------------

const TRIALIST_ROLE = 'Trialist';
const APPLY_CHANNEL = 'apply';      // substring match on the channel name
const LOG_CHANNEL = 'staff-chat';   // null to disable staff logging
const TRIAL_MODE = 'auto';          // 'auto' or 'approve'

const POSITIONS = [
  'GK', 'RB', 'CB', 'LB', 'CDM', 'CM', 'CAM',
  'RM', 'LM', 'RW', 'LW', 'ST', 'CF',
];
const SINGLE_POSITION = true;       // false to let players hold several
const NICK_LIMIT = 32;

const SUFFIX_RE = new RegExp(`\\s*\\((?:${POSITIONS.join('|')})\\)\\s*$`, 'i');

// --- helpers ---------------------------------------------------------------

function applySuffix(displayName, position) {
  const base = displayName.replace(SUFFIX_RE, '').trim();
  if (!position) return base.slice(0, NICK_LIMIT);
  const suffix = ` (${position})`;
  const room = NICK_LIMIT - suffix.length;
  return (base.slice(0, room).trim() + suffix).slice(0, NICK_LIMIT);
}

function findChannel(guild, fragment) {
  if (!fragment) return null;
  return guild.channels.cache.find(
    (c) => c.isTextBased?.() && c.name.includes(fragment)) || null;
}

function roleByName(guild, name) {
  return guild.roles.cache.find((r) => r.name === name) || null;
}

function applyEmbed() {
  return new EmbedBuilder()
    .setTitle('Apply for a trial')
    .setColor(0x2ecc71)
    .setDescription(
      `Press **Apply** and answer the questions. You get the ` +
      `**${TRIALIST_ROLE}** role straight away and the trial channels ` +
      `open up.\n\nOne application each. Answer properly, staff read every one.`,
    );
}

function applyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('trial:apply')
      .setLabel('Apply')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Success),
  );
}

function positionsEmbed() {
  return new EmbedBuilder()
    .setTitle('Pick your position')
    .setColor(0x2ecc71)
    .setDescription(
      'Press a button below. You get the role and your name updates ' +
      'automatically, e.g. **jamil2kool (CAM)**.\n' +
      'Press the same button again to remove it.',
    );
}

function positionRows() {
  const rows = [];
  for (let i = 0; i < POSITIONS.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      POSITIONS.slice(i, i + 5).map((pos) => new ButtonBuilder()
        .setCustomId(`pos:${pos}`)
        .setLabel(pos)
        .setStyle(ButtonStyle.Secondary)),
    ));
  }
  return rows;
}

function trialModal() {
  const field = (id, label, style, placeholder, max) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(style)
        .setPlaceholder(placeholder)
        .setMaxLength(max)
        .setRequired(true),
    );

  return new ModalBuilder()
    .setCustomId('trial:modal')
    .setTitle('Trial application')
    .addComponents(
      field('gamertag', 'Gamertag / in-game name', TextInputStyle.Short,
        'exactly as it appears in game', 64),
      field('platform', 'Platform and age', TextInputStyle.Short,
        'e.g. PS5, 17', 64),
      field('positions', 'Positions (1st and 2nd)', TextInputStyle.Short,
        'e.g. CAM, CM', 64),
      field('experience', 'Previous clubs and experience',
        TextInputStyle.Paragraph,
        "Clubs you've played for, how long, what level.", 500),
      field('availability', 'Availability, mic, backup?',
        TextInputStyle.Paragraph,
        'Which nights can you scrim? Mic? Happy to be backup?', 400),
    );
}

// Returns null on success, or a string explaining the failure.
async function grantTrialist(member, jumpUrl) {
  const guild = member.guild;
  const role = roleByName(guild, TRIALIST_ROLE);

  if (!role) return `Role \`${TRIALIST_ROLE}\` doesn't exist.`;
  if (role.position >= guild.members.me.roles.highest.position) {
    return `My role is below ${TRIALIST_ROLE}, so I can't assign it.`;
  }
  if (member.roles.cache.has(role.id)) return null;

  try {
    await member.roles.add(role, 'trial application');
  } catch (err) {
    return `Could not assign the role: ${err.message}`;
  }

  const logChannel = findChannel(guild, LOG_CHANNEL);
  if (logChannel) {
    const link = jumpUrl ? ` ${jumpUrl}` : '';
    await logChannel.send(
      `${member} applied and was given **${TRIALIST_ROLE}**.${link}`,
    ).catch(() => {});
  }
  return null;
}

// --- command definitions ---------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName('apply')
    .setDescription('Post the trial application panel here')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  new SlashCommandBuilder()
    .setName('positions')
    .setDescription('Post the position picker panel here')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  new SlashCommandBuilder()
    .setName('syncnames')
    .setDescription('Re-apply (POS) suffixes to everyone who has a position')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames),
].map((c) => c.toJSON());

// --- interaction handling --------------------------------------------------

// Returns true if this module handled the interaction.
async function handle(interaction) {
  if (!interaction.guild) return false;

  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {
      case 'apply':
        await interaction.channel.send({
          embeds: [applyEmbed()], components: [applyRow()],
        });
        await interaction.reply({
          content: 'Panel posted.', flags: MessageFlags.Ephemeral });
        return true;

      case 'positions':
        await interaction.channel.send({
          embeds: [positionsEmbed()], components: positionRows(),
        });
        await interaction.reply({
          content: 'Panel posted.', flags: MessageFlags.Ephemeral });
        return true;

      case 'syncnames': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const members = await interaction.guild.members.fetch();
        let changed = 0;
        for (const member of members.values()) {
          const held = member.roles.cache
            .filter((r) => POSITIONS.includes(r.name)).first();
          const target = applySuffix(member.displayName,
            held ? held.name : null);
          if (target === member.displayName) continue;
          try {
            await member.setNickname(target, 'syncnames');
            changed += 1;
            await new Promise((r) => setTimeout(r, 500));
          } catch { /* owner or higher role, skip */ }
        }
        await interaction.editReply(`Updated ${changed} nicknames.`);
        return true;
      }

      default:
        return false;
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'trial:apply') {
      const role = roleByName(interaction.guild, TRIALIST_ROLE);
      if (role && interaction.member.roles.cache.has(role.id)) {
        await interaction.reply({
          content: `You're already a **${TRIALIST_ROLE}**.`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      await interaction.showModal(trialModal());
      return true;
    }

    if (interaction.customId.startsWith('pos:')) {
      const position = interaction.customId.slice(4);
      const guild = interaction.guild;
      const member = interaction.member;
      const role = roleByName(guild, position);

      if (!role) {
        await interaction.reply({
          content: `Role \`${position}\` doesn't exist yet. Tell a manager.`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      if (role.position >= guild.members.me.roles.highest.position) {
        await interaction.reply({
          content: "My role is below the position roles, so I can't assign " +
            'them. A manager needs to drag my role higher.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      let message;
      let newNick;
      try {
        if (member.roles.cache.has(role.id)) {
          await member.roles.remove(role, 'position picker');
          newNick = applySuffix(member.displayName, null);
          message = `Removed **${position}**.`;
        } else {
          if (SINGLE_POSITION) {
            const stale = member.roles.cache.filter(
              (r) => POSITIONS.includes(r.name) && r.id !== role.id);
            if (stale.size) {
              await member.roles.remove(stale, 'position picker');
            }
          }
          await member.roles.add(role, 'position picker');
          newNick = applySuffix(member.displayName, position);
          message = `You're now **${position}**.`;
        }
      } catch (err) {
        await interaction.reply({
          content: `That failed: ${err.message}`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      if (newNick !== member.displayName) {
        try {
          await member.setNickname(newNick, 'position picker');
        } catch {
          message += member.id === guild.ownerId
            ? "\nI can't rename the server owner, that's a Discord limit. " +
              'Change your own nickname manually.'
            : "\nRole set, but I couldn't change your nickname.";
        }
      }

      await interaction.reply({
        content: message, flags: MessageFlags.Ephemeral });
      return true;
    }
    return false;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'trial:modal') {
    const member = interaction.member;
    const value = (id) => interaction.fields.getTextInputValue(id);

    const embed = new EmbedBuilder()
      .setTitle('Trial application')
      .setColor(0x2ecc71)
      .setTimestamp(new Date())
      .setAuthor({
        name: member.user.tag,
        iconURL: member.displayAvatarURL(),
      })
      .addFields(
        { name: 'Gamertag', value: value('gamertag'), inline: true },
        { name: 'Platform / age', value: value('platform'), inline: true },
        { name: 'Positions', value: value('positions'), inline: true },
        { name: 'Experience', value: value('experience') },
        { name: 'Availability', value: value('availability') },
      )
      .setFooter({ text: `user id ${member.id}` });

    const channel = findChannel(interaction.guild, APPLY_CHANNEL);
    let posted = null;
    if (channel) {
      posted = await channel.send({ embeds: [embed] }).catch(() => null);
    }

    if (TRIAL_MODE === 'approve') {
      if (posted) await posted.react('✅').catch(() => {});
      await interaction.reply({
        content: 'Application sent. A manager will review it shortly.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const error = await grantTrialist(member, posted ? posted.url : null);
    await interaction.reply({
      content: error
        ? `Application sent, but the role wasn't assigned: ${error}`
        : `You're a **${TRIALIST_ROLE}** now. Check the trial channels.`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  return false;
}

export { commands, handle, applySuffix, POSITIONS };