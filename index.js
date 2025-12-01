require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, RoleSelectMenuBuilder,
  Events, MessageFlags, PermissionsBitField,
  REST, Routes,
  SlashCommandBuilder
} = require('discord.js');
// --- Register /drtadmin Slash Command ---
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('drtadmin')
      .setDescription('Show DRT admin controls (admin only)')
      .toJSON()
  ];
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const appId = (await client.application?.fetch())?.id;
  if (!ALLOWED_GUILD_IDS.length) {
    console.error('No ALLOWED_GUILD_IDS (or GUILD_ID) set in .env. Set ALLOWED_GUILD_IDS to a comma-separated list of guild IDs you have approved.');
    return;
  }
  try {
    // Remove global /drtadmin if it exists
    const globalCommands = await rest.get(Routes.applicationCommands(appId));
    const drtGlobal = globalCommands.find(cmd => cmd.name === 'drtadmin');
    if (drtGlobal) {
      await rest.delete(Routes.applicationCommand(appId, drtGlobal.id));
      console.log('Removed global /drtadmin command');
    }
    // Register for each allowed guild
    for (const guildId of ALLOWED_GUILD_IDS) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(appId, guildId),
          { body: commands }
        );
        console.log(`Registered /drtadmin for guild ${guildId}`);
      } catch (guildErr) {
        console.error(`Failed to register /drtadmin for guild ${guildId}:`, guildErr);
      }
    }
  } catch (err) {
    console.error('Failed to register/cleanup slash command:', err);
  }
}
const { DateTime } = require('luxon');
const fetch = require('node-fetch');
const {
  setState, getState,
  addPlayers, removePlayers, listPlayers,
  clearPlayers, clearTournamentData, setNickname, getNickname,
  listUserPlayers, getAllPlayerEntries, removePlayerForUser,
  setTournamentStatus, getTournamentStatus,
  setDefaultTz, getDefaultTz
} = require('./db');

// --- Client Setup ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

const CHANNEL_ID = process.env.CHANNEL_ID;
const OWNER_ROLE = process.env.OWNER_ROLE_ID;
const STAFF_ROLE = process.env.STAFF_ROLE_ID;
const ALLOWED_GUILD_IDS = (process.env.ALLOWED_GUILD_IDS || process.env.GUILD_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

function resolveOwnerRoleId(guildId) {
  return getState(guildId, 'ownerRoleId') || OWNER_ROLE || null;
}

function resolveStaffRoleId(guildId) {
  return getState(guildId, 'staffRoleId') || STAFF_ROLE || null;
}

function getAdminFlags(interaction, guildId) {
  const member = interaction.member;
  const ownerId = resolveOwnerRoleId(guildId);
  const staffId = resolveStaffRoleId(guildId);
  const hasOwnerRole = ownerId ? member?.roles?.cache?.has(ownerId) : false;
  const hasStaffRole = staffId ? member?.roles?.cache?.has(staffId) : false;
  const hasAdminPerm = member?.permissions?.has(PermissionsBitField.Flags.Administrator);
  return {
    hasOwnerRole,
    hasStaffRole,
    hasAdminPerm,
    isAdmin: !!(hasOwnerRole || hasStaffRole || hasAdminPerm)
  };
}

// Cache admin remove menu options per user to avoid large option payloads
const adminRemovalCache = new Map();

// --- Build TZ Options ---
function buildTzOptions(zones) {
  return zones.map(z => {
    const dt = DateTime.now().setZone(z);
    const offset = dt.toFormat('ZZZZ');
    const timeNow = dt.toFormat('HH:mm');
    return { label: `${z} (${offset}) � ${timeNow}`, value: z };
  });
}

// NA & EU zone lists
const naZones = [
  'America/New_York', 'America/Detroit', 'America/Toronto',
  'America/Chicago', 'America/Winnipeg', 'America/Mexico_City',
  'America/Denver', 'America/Phoenix', 'America/Edmonton',
  'America/Los_Angeles', 'America/Vancouver', 'America/Anchorage',
  'Pacific/Honolulu'
];
const euZones = [
  'Europe/London', 'Europe/Dublin', 'Europe/Lisbon',
  'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
  'Europe/Rome', 'Europe/Amsterdam', 'Europe/Brussels',
  'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen',
  'Europe/Helsinki', 'Europe/Athens', 'Europe/Bucharest',
  'Europe/Warsaw'
];

// --- Build Signup Buttons ---
function buildSignupRows(status, guildId) {
  if (status === 'none') {
    // Only show the Interact button
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('interact').setLabel('Interact').setStyle(ButtonStyle.Primary)
    );
    return [row];
  }

  // Show all regular buttons except admin
  const row = new ActionRowBuilder();
  if (status === 'scheduled') {
    row.addComponents(
      new ButtonBuilder().setCustomId('signup').setLabel('Sign Me Up').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('setnick').setLabel('Set Nickname').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('signupfriends').setLabel('Sign Up Friends').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('withdraw').setLabel('Withdraw').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('list').setLabel('List Players').setStyle(ButtonStyle.Secondary)
    );
  } else if (status === 'in-progress') {
    const challongeUrl = getState(guildId, 'challongeUrl');
    if (challongeUrl) {
      row.addComponents(
        new ButtonBuilder().setLabel('View Bracket').setStyle(ButtonStyle.Link).setURL(challongeUrl)
      );
    }
  }
  return [row];
}

// --- Challonge Integration ---
async function pushToChallonge(bracket) {
  const res = await fetch(`https://api.challonge.com/v1/tournaments.json?api_key=${process.env.CHALLONGE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tournament: { name: bracket.name, tournament_type: 'single elimination' }
    })
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  const tourn = data.tournament;

  for (const player of bracket.players) {
    const pr = await fetch(`https://api.challonge.com/v1/tournaments/${tourn.id}/participants.json?api_key=${process.env.CHALLONGE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participant: { name: player } })
    });
    if (!pr.ok) throw new Error(await pr.text());
  }
  return tourn;
}

async function startChallongeTournament(tid) {
  const res = await fetch(`https://api.challonge.com/v1/tournaments/${tid}/start.json?api_key=${process.env.CHALLONGE_API_KEY}`, {
    method: 'POST'
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --- Get Current Match from Challonge ---
async function getCurrentMatch(tournamentId) {
  try {
    // Get matches
    const matchesRes = await fetch(`https://api.challonge.com/v1/tournaments/${tournamentId}/matches.json?api_key=${process.env.CHALLONGE_API_KEY}`);
    if (!matchesRes.ok) throw new Error(await matchesRes.text());
    const matchesData = await matchesRes.json();

    // Get participants to map IDs to names
    const participantsRes = await fetch(`https://api.challonge.com/v1/tournaments/${tournamentId}/participants.json?api_key=${process.env.CHALLONGE_API_KEY}`);
    if (!participantsRes.ok) throw new Error(await participantsRes.text());
    const participantsData = await participantsRes.json();

    // Create participant mapping
    const participantMap = {};
    participantsData.forEach(p => {
      const participant = p.participant || p;
      participantMap[participant.id] = participant.name;
    });

    // Find the current match (first open match without scores)
    const matches = matchesData.map(m => m.match || m);
    const currentMatch = matches.find(match => 
      match.state === 'open' && 
      (!match.scores_csv || match.scores_csv.trim() === '')
    );

    if (!currentMatch) {
      return null; // No current match
    }

    const player1 = participantMap[currentMatch.player1_id] || 'TBD';
    const player2 = participantMap[currentMatch.player2_id] || 'TBD';

    return {
      player1,
      player2,
      round: currentMatch.round,
      matchId: currentMatch.id
    };
  } catch (error) {
    console.error('Error getting current match:', error);
    return null;
  }
}

// --- Signup Message ---
async function postSignupMessage(channel, guildId) {
  const players = listPlayers(guildId);
  const tname = getState(guildId, 'tournamentName') || 'Death Roll Tournament';
  const ttime = getState(guildId, 'tournamentTime') || 'TBD';
  const status = getTournamentStatus(guildId);

  let content;
  if (status === 'none') {
    content = '⚔️ Death Roll signups are not open. An admin must create a tournament to begin.';
  } else if (status === 'scheduled') {
    content = `⚔️ **${tname}**\nScheduled: ${ttime}\nCurrent signups: **${players.length}**`;
  } else {
    const challongeUrl = getState(guildId, 'challongeUrl');
    if (challongeUrl) {
      // Get current match info for live tournaments
      const challongeId = getState(guildId, 'challongeId');
      if (challongeId) {
        const currentMatch = await getCurrentMatch(challongeId);
        if (currentMatch) {
          content = `⚔️ **${tname}**\n🏆 Tournament is live!\n⚡ **Current Match:** ${currentMatch.player1} vs ${currentMatch.player2} (Round ${currentMatch.round})`;
        } else {
          content = `⚔️ **${tname}**\n🏆 Tournament is live!\n✅ All matches complete!`;
        }
      } else {
        content = `⚔️ **${tname}**\n🏆 Tournament is live!`;
      }
    } else {
      content = `⚔️ **${tname}**\n🏆 Tournament in progress...`;
    }
  }

  const rows = buildSignupRows(status, guildId);

  const msg = await channel.send({ content, components: rows });
  setState(guildId, 'signupMessageId', msg.id);
  setState(guildId, 'signupChannelId', channel.id);
  return msg;
}

// --- Update Signup Message ---
async function updateSignupMessage(client, guildId) {
  const messageId = getState(guildId, 'signupMessageId');
  const channelId = getState(guildId, 'signupChannelId');
  if (!messageId || !channelId) return;

  const channel = await client.channels.fetch(channelId);
  const msg = await channel.messages.fetch(messageId);
  const players = listPlayers(guildId);
  const tname = getState(guildId, 'tournamentName') || 'Death Roll Tournament';
  const ttime = getState(guildId, 'tournamentTime') || 'TBD';
  const status = getTournamentStatus(guildId);

  let content;
  if (status === 'none') {
    content = '⚔️ Death Roll signups are not open. An admin must create a tournament to begin.';
  } else if (status === 'scheduled') {
    content = `⚔️ **${tname}**\nScheduled: ${ttime}\nCurrent signups: **${players.length}**`;
  } else {
    const challongeUrl = getState(guildId, 'challongeUrl');
    if (challongeUrl) {
      // Get current match info for live tournaments
      const challongeId = getState(guildId, 'challongeId');
      if (challongeId) {
        const currentMatch = await getCurrentMatch(challongeId);
        if (currentMatch) {
          content = `⚔️ **${tname}**\n🏆 Tournament is live!\n⚡ **Current Match:** ${currentMatch.player1} vs ${currentMatch.player2} (Round ${currentMatch.round})`;
        } else {
          content = `⚔️ **${tname}**\n🏆 Tournament is live!\n✅ All matches complete!`;
        }
      } else {
        content = `⚔️ **${tname}**\n🏆 Tournament is live!`;
      }
    } else {
      content = `⚔️ **${tname}**\n🏆 Tournament in progress...`;
    }
  }

  const rows = buildSignupRows(status, guildId);
  await msg.edit({ content, components: rows });
}

// --- Helper Function for Timed Replies ---
// Note: True ephemeral messages can't be deleted programmatically.
// This helper standardizes private replies without timers to avoid API warnings.
async function timedReply(interaction, options, duration = 10000) {
  return interaction.reply({ ...options, flags: MessageFlags.Ephemeral });
}

// --- End Existing Bracket ---
async function endExistingBracket(interaction, guildId) {
  const existingId = getState(guildId, 'challongeId');
  if (!existingId) {
    return timedReply(interaction, { content: '❌ No existing bracket to end.' }, 30000);
  }

  try {
    // 1) Look up current tournament state
    const infoRes = await fetch(`https://api.challonge.com/v1/tournaments/${existingId}.json?api_key=${process.env.CHALLONGE_API_KEY}`);
    if (!infoRes.ok) throw new Error(await infoRes.text());
    const infoData = await infoRes.json();
    const tourn = infoData?.tournament || infoData; // defensive: some libs wrap under { tournament }
    const state = tourn?.state;

    // 2) If already complete, just clear local state
    if (state === 'complete') {
      setState(guildId, 'challongeId', null);
      setState(guildId, 'challongeUrl', null);
      setTournamentStatus(guildId, 'none');
      await updateSignupMessage(client, guildId);
      return timedReply(interaction, { content: '✅ Bracket is already complete. Cleared saved bracket and reset status.' }, 30000);
    }

    // 3) Try to finalize if not yet complete
    const finRes = await fetch(`https://api.challonge.com/v1/tournaments/${existingId}/finalize.json?api_key=${process.env.CHALLONGE_API_KEY}`, {
      method: 'POST'
    });

    if (!finRes.ok) {
      const errText = await finRes.text();
      // Fallback: clear local state even if Challonge refuses finalize (e.g., missing scores)
      setState(guildId, 'challongeId', null);
      setState(guildId, 'challongeUrl', null);
      setTournamentStatus(guildId, 'none');
      await updateSignupMessage(client, guildId);
      return timedReply(
        interaction,
        { content: `⚠️ Could not finalize on Challonge (${errText.trim()}). Cleared saved bracket locally so you can create a new one.` },
        30000
      );
    }

    // 4) Finalized successfully
    setState(guildId, 'challongeId', null);
    setState(guildId, 'challongeUrl', null);
    setTournamentStatus(guildId, 'none');
    await updateSignupMessage(client, guildId);
    return timedReply(interaction, { content: '✅ Bracket finalized on Challonge and cleared locally.' }, 30000);
  } catch (err) {
    console.error('Error finalizing bracket:', err);
    // Fallback: clear locally so workflow can continue
    setState(guildId, 'challongeId', null);
    setState(guildId, 'challongeUrl', null);
    setTournamentStatus(guildId, 'none');
    try { await updateSignupMessage(client, guildId); } catch {}
    return timedReply(
      interaction,
      { content: `⚠️ Could not reach Challonge to finalize (details in logs). Cleared saved bracket locally so you can proceed.` },
      30000
    );
  }
}

// --- Bot Startup ---
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register slash commands
  await registerSlashCommands();

  // Restore/signup message per allowed guild if a channel is stored
  for (const guildId of ALLOWED_GUILD_IDS) {
    const legacyGuildId = (process.env.GUILD_ID || '').trim();
    const channelId = getState(guildId, 'signupChannelId') ||
      (legacyGuildId && guildId === legacyGuildId ? CHANNEL_ID : null); // fallback to env only for the legacy primary guild
    if (!channelId) {
      console.warn(`No signup channel configured for guild ${guildId}; run /drtadmin in the desired channel to set it.`);
      continue;
    }
    try {
      const channel = await client.channels.fetch(channelId);
      try {
        const messageId = getState(guildId, 'signupMessageId');
        if (messageId) {
          try {
            const oldMsg = await channel.messages.fetch(messageId);
            await oldMsg.delete();
          } catch {}
        }
        await postSignupMessage(channel, guildId);
        console.log(`Posted signup message for guild ${guildId}`);
      } catch (err) {
        console.error(`Startup error posting signup message for guild ${guildId}:`, err);
      }
    } catch (err) {
      console.error(`Could not fetch signup channel ${channelId} for guild ${guildId}:`, err);
    }
  }

  // Start periodic updates for current match info
  setInterval(async () => {
    try {
      for (const guildId of ALLOWED_GUILD_IDS) {
        const status = getTournamentStatus(guildId);
        if (status === 'in-progress') {
          await updateSignupMessage(client, guildId);
        }
      }
    } catch (error) {
      console.error('Error updating current match:', error);
    }
  }, 5000); // Update every 5 seconds
});

// Auto-leave any guilds not in the allowlist
client.on(Events.GuildCreate, async (guild) => {
  const allowed = ALLOWED_GUILD_IDS;
  if (allowed.length > 0 && !allowed.includes(guild.id)) {
    console.warn(`Joined unauthorized guild ${guild.id} (${guild.name}). Leaving...`);
    try {
      await guild.leave();
      console.warn(`Left unauthorized guild ${guild.id}.`);
    } catch (err) {
      console.error(`Failed to leave unauthorized guild ${guild.id}:`, err);
    }
  }
});

// --- Interactions ---
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    const guildId = interaction.guildId;
    if (!guildId || (ALLOWED_GUILD_IDS.length > 0 && !ALLOWED_GUILD_IDS.includes(guildId))) {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({ content: 'Not authorized to use this bot on this server.', flags: MessageFlags.Ephemeral });
        } catch (replyErr) {
          console.error('Failed to send unauthorized reply:', replyErr);
        }
      }
      return;
    }

    // --- Handle /drtadmin slash command ---
    if (interaction.isChatInputCommand && interaction.commandName === 'drtadmin') {
      const adminFlags = getAdminFlags(interaction, guildId);
      if (!adminFlags.isAdmin) {
        return interaction.reply({ content: '❌ Not allowed.', ephemeral: true });
      }
      // If this guild has no signup channel yet, default to the current channel and post the signup message
      let signupChannelId = getState(guildId, 'signupChannelId');
      if (!signupChannelId && interaction.channel) {
        try {
          await postSignupMessage(interaction.channel, guildId);
          signupChannelId = interaction.channel.id;
          console.log(`Initialized signup channel for guild ${guildId} to ${signupChannelId}`);
        } catch (initErr) {
          console.error('Failed to bootstrap signup message for guild', guildId, initErr);
        }
      }

      const adminButtons = [
        new ButtonBuilder().setCustomId('start').setLabel('Start Bracket').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('newtournament').setLabel('New Tournament').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('createbracket').setLabel('Create Bracket').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('setchannel').setLabel('Set Signup Channel').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setroles').setLabel('Set Roles').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('settz').setLabel('Set Default Time Zone').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('removeplayer').setLabel('Remove Player').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('killtournament').setLabel('Kill Tournament').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('endbracket').setLabel('End Bracket').setStyle(ButtonStyle.Danger)
      ];

      const components = [];
      for (let i = 0; i < adminButtons.length; i += 5) {
        const slice = adminButtons.slice(i, i + 5);
        if (slice.length > 0) {
          components.push(new ActionRowBuilder().addComponents(...slice));
        }
      }
      const challongeUrl = getState(guildId, 'challongeUrl');
      if (challongeUrl) {
        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('View Bracket').setStyle(ButtonStyle.Link).setURL(challongeUrl)
        );
        components.push(row2);
      }
      try {
        return await interaction.reply({
          content: '⚔️ **Admin Controls**',
          components,
          flags: MessageFlags.Ephemeral
        });
      } catch (replyErr) {
        console.error('Could not reply to /drtadmin command:', replyErr);
      }
    }

    if (interaction.isButton()) {
      // Interact button handler
      if (interaction.customId === 'interact') {
        const status = getTournamentStatus(guildId);
        const rows = [];
        const row = new ActionRowBuilder();
        // Always show Set Nickname
        row.addComponents(new ButtonBuilder().setCustomId('setnick').setLabel('Set Nickname').setStyle(ButtonStyle.Secondary));
        // Show other options based on tournament state
        if (status === 'scheduled') {
          row.addComponents(
            new ButtonBuilder().setCustomId('signup').setLabel('Sign Me Up').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('signupfriends').setLabel('Sign Up Friends').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('withdraw').setLabel('Withdraw').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('list').setLabel('List Players').setStyle(ButtonStyle.Secondary)
          );
        } else if (status === 'in-progress') {
          row.addComponents(
            new ButtonBuilder().setCustomId('list').setLabel('List Players').setStyle(ButtonStyle.Secondary)
          );
        }
        rows.push(row);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply({
          content: 'Available actions:',
          components: rows
        });
      }
      // Sign up
      if (interaction.customId === 'signup') {
        if (getTournamentStatus(guildId) !== 'scheduled') {
          return timedReply(interaction, { content: 'Signups are closed right now.' }, 30000);
        }
        const nick = getNickname(guildId, interaction.user.id);
        const displayName = nick || interaction.member?.displayName || interaction.user.username;

        const existing = listPlayers(guildId);
        if (existing.includes(displayName)) {
          return timedReply(interaction, { content: `⚠️ You're already signed up as **${displayName}**.` }, 30000);
        }

        addPlayers(guildId, interaction.user.id, [displayName]);
        await timedReply(interaction, { content: `✅ Signed up: ${displayName}` }, 10000);
        return updateSignupMessage(client, guildId);
      }

      // Set Nickname
      if (interaction.customId === 'setnick') {
        const modal = new ModalBuilder()
          .setCustomId('setnickModal')
          .setTitle('Set Nickname');
        const input = new TextInputBuilder()
          .setCustomId('nickname')
          .setLabel('Enter your nickname (max 233 characters)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(233);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      // Sign up Friends
      if (interaction.customId === 'signupfriends') {
        if (getTournamentStatus(guildId) !== 'scheduled') {
          return timedReply(interaction, { content: 'Signups are closed right now.' }, 30000);
        }
        const modal = new ModalBuilder()
          .setCustomId('signupFriendsModal')
          .setTitle('Sign Up Friends (comma or newline separated)');
        const input = new TextInputBuilder()
          .setCustomId('names')
          .setLabel('Enter up to 5 names')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      // Withdraw
      if (interaction.customId === 'withdraw') {
        const mine = listUserPlayers(guildId, interaction.user.id);
        if (!mine || mine.length === 0) {
          return timedReply(interaction, { content: '❌ You have no signups to withdraw.' }, 30000);
        }

        const options = mine.slice(0, 25).map((n, i) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(String(n).substring(0, 100))
            .setValue(`${n}-${i}`) // ensure unique values
        );

        const row1 = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('withdrawSelect')
            .setPlaceholder('Select players to withdraw')
            .setMinValues(1)
            .setMaxValues(options.length)
            .addOptions(options)
        );

        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('withdrawAll').setLabel('Withdraw All').setStyle(ButtonStyle.Danger)
        );

        try {
          await interaction.reply({
            content: '🗑️ Select players to withdraw, or click **Withdraw All**:',
            components: [row1, row2],
            flags: MessageFlags.Ephemeral
          });
        } catch (err) {
          console.error('Withdraw reply error:', err);
          return timedReply(interaction, { content: '❌ Failed to open withdraw menu.' }, 30000);
        }
      }

      // Withdraw All
      if (interaction.customId === 'withdrawAll') {
        const mine = listUserPlayers(guildId, interaction.user.id);
        if (mine.length === 0) {
          return interaction.update({ content: '❌ Nothing to withdraw.', components: [] });
        }
        removePlayers(guildId, interaction.user.id, mine);
        await interaction.update({ content: '✅ All your signups have been withdrawn.', components: [] });
        return updateSignupMessage(client, guildId);
      }

      // List Players
      if (interaction.customId === 'list') {
        const entries = getAllPlayerEntries(guildId);
        console.log('List button entries count:', entries.length);
        if (entries.length === 0) {
          return timedReply(interaction, { content: '📝 No signups yet.' }, 30000);
        }

        const lines = entries.map(({ name }, idx) => `${idx + 1}. ${name}`);
        const chunks = [];
        let current = `**Signups (${entries.length})**`;

        for (const line of lines) {
          if (current.length + line.length + 1 > 1900) {
            chunks.push(current);
            current = line;
          } else {
            current += `\n${line}`;
          }
        }

        if (current.length > 0) {
          chunks.push(current);
        }

        if (chunks.length === 0) {
          return timedReply(interaction, { content: '📝 No signups yet.' }, 30000);
        }

        try {
          await interaction.reply({ content: chunks[0], flags: MessageFlags.Ephemeral });
        } catch (replyErr) {
          console.error('Failed to reply with signup list:', replyErr);
          return;
        }

        await Promise.all(chunks.slice(1).map(async (chunk) => {
          try {
            await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
          } catch (followErr) {
            console.error('Failed to send signup list follow-up:', followErr);
          }
        }));

        return;
      }


      // Set Default Time Zone
      if (interaction.customId === 'settz') {
        const naMenu = new StringSelectMenuBuilder()
          .setCustomId('tzSelectNA')
          .setPlaceholder('Select a North America timezone')
          .addOptions(buildTzOptions(naZones));
        const euMenu = new StringSelectMenuBuilder()
          .setCustomId('tzSelectEU')
          .setPlaceholder('Select a Europe timezone')
          .addOptions(buildTzOptions(euZones));

        return interaction.reply({
          content: '🌍 Please select a default time zone for tournaments:',
          components: [new ActionRowBuilder().addComponents(naMenu), new ActionRowBuilder().addComponents(euMenu)],
          flags: MessageFlags.Ephemeral
        });
      }

      // Set Signup Channel (admin)
      if (interaction.customId === 'setchannel') {
        const adminFlags = getAdminFlags(interaction, guildId);
        if (!adminFlags.isAdmin) {
          return interaction.reply({ content: '🚫 Only Owners or Staff can set the signup channel.', flags: MessageFlags.Ephemeral });
        }
        const targetChannel = interaction.channel;
        if (!targetChannel) {
          return timedReply(interaction, { content: '🚫 Cannot set signup channel here.', flags: MessageFlags.Ephemeral }, 30000);
        }

        const oldChannelId = getState(guildId, 'signupChannelId');
        const oldMessageId = getState(guildId, 'signupMessageId');
        if (oldChannelId && oldMessageId) {
          try {
            const oldChannel = await client.channels.fetch(oldChannelId);
            const oldMsg = await oldChannel.messages.fetch(oldMessageId);
            await oldMsg.delete();
          } catch (err) {
            console.warn('Could not delete previous signup message:', err);
          }
        }

        try {
          await postSignupMessage(targetChannel, guildId);
          return timedReply(interaction, { content: `✅ Signup channel set to <#${targetChannel.id}> and signup message refreshed.`, flags: MessageFlags.Ephemeral }, 30000);
        } catch (err) {
          console.error('Failed to set signup channel:', err);
          return timedReply(interaction, { content: '🚫 Failed to set signup channel. Check bot permissions and try again.', flags: MessageFlags.Ephemeral }, 30000);
        }
      }

      // Set Roles (admin)
      if (interaction.customId === 'setroles') {
        const adminFlags = getAdminFlags(interaction, guildId);
        if (!(adminFlags.hasOwnerRole || adminFlags.hasAdminPerm)) {
          return interaction.reply({ content: '🚫 Only Owners (or server admins) can set roles.', flags: MessageFlags.Ephemeral });
        }

        const ownerRoleId = resolveOwnerRoleId(guildId);
        const staffRoleId = resolveStaffRoleId(guildId);

        const ownerSelect = new RoleSelectMenuBuilder()
          .setCustomId('ownerRoleSelect')
          .setPlaceholder('Select Owner role')
          .setMinValues(1)
          .setMaxValues(1);

        const staffSelect = new RoleSelectMenuBuilder()
          .setCustomId('staffRoleSelect')
          .setPlaceholder('Select Staff role (optional)')
          .setMinValues(0)
          .setMaxValues(1);

        const clearStaff = new ButtonBuilder()
          .setCustomId('clearStaffRole')
          .setLabel('Clear Staff Role')
          .setStyle(ButtonStyle.Secondary);

        const summary = [
          `Owner role: ${ownerRoleId ? `<@&${ownerRoleId}>` : 'not set'}`,
          `Staff role: ${staffRoleId ? `<@&${staffRoleId}>` : 'not set'}`
        ].join('\n');

        return interaction.reply({
          content: `Select roles to use for admin checks.\n${summary}`,
          components: [
            new ActionRowBuilder().addComponents(ownerSelect),
            new ActionRowBuilder().addComponents(staffSelect),
            new ActionRowBuilder().addComponents(clearStaff)
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      if (interaction.customId === 'clearStaffRole') {
        const adminFlags = getAdminFlags(interaction, guildId);
        if (!(adminFlags.hasOwnerRole || adminFlags.hasAdminPerm)) {
          return interaction.reply({ content: '🚫 Not allowed.', flags: MessageFlags.Ephemeral });
        }
        setState(guildId, 'staffRoleId', null);
        const ownerRoleId = resolveOwnerRoleId(guildId);
        const summary = [
          `Owner role: ${ownerRoleId ? `<@&${ownerRoleId}>` : 'not set'}`,
          'Staff role: not set'
        ].join('\n');
        return interaction.update({
          content: `Select roles to use for admin checks.\n${summary}`,
          components: interaction.message.components
        });
      }

      if (interaction.customId === 'removeplayer') {
        const adminFlags = getAdminFlags(interaction, guildId);
        if (!adminFlags.isAdmin) {
          return interaction.reply({ content: '❌ Only Owners or Staff can remove players.', flags: MessageFlags.Ephemeral });
        }

        const entries = getAllPlayerEntries(guildId);
        if (entries.length === 0) {
          return interaction.reply({ content: '📝 No players to remove.', flags: MessageFlags.Ephemeral });
        }

        const chunkSize = 25;
        const cachePrefix = `${guildId}:${interaction.user.id}:`;
        for (const key of adminRemovalCache.keys()) {
          if (key.startsWith(cachePrefix)) {
            adminRemovalCache.delete(key);
          }
        }
        const components = [];
        const menuCount = Math.ceil(entries.length / chunkSize);
        const rowsLimit = Math.min(menuCount, 5);

        for (let chunkIndex = 0, page = 0; chunkIndex < entries.length && page < rowsLimit; chunkIndex += chunkSize, page += 1) {
          const chunk = entries.slice(chunkIndex, chunkIndex + chunkSize);
          const cacheKey = `${cachePrefix}${page}`;
          adminRemovalCache.set(cacheKey, chunk);

          const options = chunk.map(({ userId, name }, idx) => {
            const option = new StringSelectMenuOptionBuilder()
              .setLabel(String(name).substring(0, 100) || `Player ${chunkIndex + idx + 1}`)
              .setValue(String(idx));
            const nickname = getNickname(guildId, userId);
            if (nickname) option.setDescription(nickname.substring(0, 100));
            return option;
          });

          const start = chunkIndex + 1;
          const end = chunkIndex + chunk.length;
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`adminRemoveSelect:${page}`)
            .setPlaceholder(`Select players ${start}-${end}`)
            .setMinValues(1)
            .setMaxValues(options.length)
            .addOptions(options);

          components.push(new ActionRowBuilder().addComponents(menu));
        }

        let note = `Select players to remove (showing ${Math.min(entries.length, rowsLimit * chunkSize)} of ${entries.length}).`;
        if (menuCount > rowsLimit) {
          note += ' Showing first 5 menus due to Discord limits.';
        }

        return interaction.reply({
          content: note,
          components,
          flags: MessageFlags.Ephemeral
        });
      }

      // New Tournament
      if (interaction.customId === 'newtournament') {
        // Check if there's already an active tournament
        const currentStatus = getTournamentStatus(guildId);
        if (currentStatus === 'in-progress') {
          return interaction.reply({
            content: '❌ Cannot create a new tournament while one is currently in progress. Please end the current tournament first.',
            flags: MessageFlags.Ephemeral
          });
        }

        const modal = new ModalBuilder().setCustomId('newTournamentModal').setTitle('New Tournament');

        const nameInput = new TextInputBuilder().setCustomId('tname').setLabel('Tournament Name').setStyle(TextInputStyle.Short).setRequired(true);
        const dateInput = new TextInputBuilder().setCustomId('tdate').setLabel('Date (MM-DD-YY)').setStyle(TextInputStyle.Short).setRequired(true);
        const timeInput = new TextInputBuilder().setCustomId('ttime').setLabel('Time (HH:MM)').setStyle(TextInputStyle.Short).setRequired(true);
        const ampmInput = new TextInputBuilder().setCustomId('ampm').setLabel('AM or PM').setStyle(TextInputStyle.Short).setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(nameInput),
          new ActionRowBuilder().addComponents(dateInput),
          new ActionRowBuilder().addComponents(timeInput),
          new ActionRowBuilder().addComponents(ampmInput)
        );

        try {
          return await interaction.showModal(modal);
        } catch (err) {
          console.error('Error showing new tournament modal:', err);
          return interaction.reply({
            content: '❌ Failed to open tournament creation form. Please try again.',
            flags: MessageFlags.Ephemeral
          });
        }
      }

      // Create Bracket
      if (interaction.customId === 'createbracket') {
        const adminFlags = getAdminFlags(interaction, guildId);
        if (!(adminFlags.hasOwnerRole || adminFlags.hasAdminPerm)) return timedReply(interaction, { content: '❌ Only Owners can create brackets.' }, 30000);

        if (getTournamentStatus(guildId) !== 'scheduled') {
          return timedReply(interaction, { content: '❌ No scheduled tournament to create a bracket for.' }, 30000);
        }

        const existingId = getState(guildId, 'challongeId');
        if (existingId) {
          const url = getState(guildId, 'challongeUrl');
          return timedReply(interaction, { content: `⚠️ A Challonge tournament already exists.\n${url ?? '(no url saved)'}` }, 30000);
        }

        const players = listPlayers(guildId);
        if (players.length < 2) {
          return timedReply(interaction, { content: '❌ Not enough players to create a bracket.' }, 30000);
        }

        const tname = getState(guildId, 'tournamentName') || 'Death Roll Tournament';
        const ttime = getState(guildId, 'tournamentTime') || 'TBD';
        const bracket = { name: tname, time: ttime, players: [...players], createdAt: new Date().toISOString() };
        setState(guildId, 'bracket', bracket);

        let deferred = true;
        try {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } catch (ackErr) {
          deferred = false;
          console.error('Failed to acknowledge create bracket interaction:', ackErr);
        }

        if (!deferred) {
          // Interaction token is no longer valid; avoid additional replies that would throw.
          return;
        }

        try {
          const tourn = await pushToChallonge(bracket);
          setState(guildId, 'challongeId', tourn.id);
          setState(guildId, 'challongeUrl', tourn.full_challonge_url);

          try {
            const channel = await client.channels.fetch(getState(guildId, 'signupChannelId'));
            await channel.send(`🏆 Bracket for **${tname}** is live!\n${tourn.full_challonge_url}`);
          } catch (announceErr) {
            console.error('Failed to announce new bracket:', announceErr);
          }

          return await interaction.editReply({
            content: `🏆 Bracket created on Challonge for **${tname}** with ${players.length} players.\n${tourn.full_challonge_url}`
          });
        } catch (err) {
          console.error('Failed to create Challonge tournament:', err);
          const errorMessage = err?.message ? `❌ Failed to create Challonge tournament: ${err.message}` : '❌ Failed to create Challonge tournament.';
          return interaction.editReply({ content: errorMessage });
        }
      }

      // Start Bracket
      if (interaction.customId === 'start') {
        const adminFlags = getAdminFlags(interaction, guildId);
        if (!(adminFlags.hasOwnerRole || adminFlags.hasAdminPerm)) return interaction.reply({ content: '?? Only Owners can start the bracket.', flags: MessageFlags.Ephemeral });

        const tid = getState(guildId, 'challongeId');
        if (!tid) return interaction.reply({ content: '?? No Challonge tournament created yet.', flags: MessageFlags.Ephemeral });

        try {


          await startChallongeTournament(tid);
          clearPlayers(guildId);
          setTournamentStatus(guildId, 'in-progress');
          await updateSignupMessage(client, guildId);
          return interaction.reply({ content: '🏆 Tournament started on Challonge!', flags: MessageFlags.Ephemeral });
        } catch (err) {
          console.error(err);
          return interaction.reply({ content: `❌ Failed to start: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
      }

      // Kill Tournament
      if (interaction.customId === 'killtournament') {
        const adminFlags = getAdminFlags(interaction, guildId);
        if (!(adminFlags.hasOwnerRole || adminFlags.hasAdminPerm)) {
          return interaction.reply({ 
            content: '?? Only Owners can kill tournaments.', 
            flags: MessageFlags.Ephemeral 
          });
        }

        try {

          // Clear all tournament-related data using the dedicated function
          clearTournamentData(guildId);

          // Try to update the signup message, but don't fail if it doesn't work
          try {
            await updateSignupMessage(client, guildId);
          } catch (updateError) {
            console.warn('Could not update signup message after killing tournament:', updateError);
            // If update fails, try to post a new signup message
            try {
              const channelId = getState(guildId, 'signupChannelId');
              if (channelId) {
                const channel = await client.channels.fetch(channelId);
                await postSignupMessage(channel, guildId);
              }
            } catch (postError) {
              console.error('Could not post new signup message:', postError);
            }
          }
          
          return interaction.reply({
            content: '🗑️ **Tournament killed!** All signups cleared and tournament status reset to "none".',
            flags: MessageFlags.Ephemeral
          });
        } catch (error) {
          console.error('Error killing tournament:', error);
          return interaction.reply({
            content: '❌ An error occurred while killing the tournament. Check the console for details.',
            flags: MessageFlags.Ephemeral
          });
        }
      }

      // End Bracket
      if (interaction.customId === 'endbracket') {
        return endExistingBracket(interaction);
      }
    }

    // Role Select Menus (owner/staff config)
    if (interaction.isRoleSelectMenu()) {
      const adminFlags = getAdminFlags(interaction, guildId);
      if (!(adminFlags.hasOwnerRole || adminFlags.hasAdminPerm)) {
        return interaction.update({ content: '🚫 Not allowed.', components: [] });
      }

      const updateSummary = () => {
        const ownerRoleId = resolveOwnerRoleId(guildId);
        const staffRoleId = resolveStaffRoleId(guildId);
        return `Select roles to use for admin checks.\nOwner role: ${ownerRoleId ? `<@&${ownerRoleId}>` : 'not set'}\nStaff role: ${staffRoleId ? `<@&${staffRoleId}>` : 'not set'}`;
      };

      if (interaction.customId === 'ownerRoleSelect') {
        const roleId = interaction.values[0];
        setState(guildId, 'ownerRoleId', roleId);
        return interaction.update({ content: updateSummary(), components: interaction.message.components });
      }

      if (interaction.customId === 'staffRoleSelect') {
        const roleId = interaction.values[0];
        if (roleId) setState(guildId, 'staffRoleId', roleId);
        return interaction.update({ content: updateSummary(), components: interaction.message.components });
      }
    }

    // Select Menus
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'withdrawSelect') {
        const selected = interaction.values.map(v => v.split('-')[0]); // strip index
        removePlayers(guildId, interaction.user.id, selected);
        await timedReply(interaction, { content: `🗑️ Removed: ${selected.join(', ')}` }, 10000);
        return updateSignupMessage(client, guildId);
      }

      if (interaction.customId.startsWith('adminRemoveSelect')) {
        const adminFlags = getAdminFlags(interaction, guildId);
        if (!adminFlags.isAdmin) {
          return interaction.update({ content: '❌ Not allowed.', components: [] });
        }

        const [, pageStr = '0'] = interaction.customId.split(':');
        const cacheKey = `${guildId}:${interaction.user.id}:${pageStr}`;
        const cachedEntries = adminRemovalCache.get(cacheKey) || [];

        const removed = [];
        const failed = [];

        for (const value of interaction.values) {
          try {
            const idx = Number(value);
            if (!Number.isInteger(idx) || idx < 0 || idx >= cachedEntries.length) {
              failed.push('Unknown');
              continue;
            }
            const payload = cachedEntries[idx];
            const ok = payload && removePlayerForUser(guildId, payload.userId, payload.name);
            if (ok) {
              removed.push(payload.name);
            } else {
              failed.push(payload?.name ?? 'Unknown');
            }
          } catch (err) {
            console.error('Failed to decode admin removal selection:', err);
            failed.push('Unknown');
          }
        }

        adminRemovalCache.delete(cacheKey);

        const seen = new Set();
        const uniqueRemoved = removed.filter(name => {
          const key = name.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const parts = [];
        if (uniqueRemoved.length > 0) parts.push(`✅ Removed: ${uniqueRemoved.join(', ')}`);
        if (failed.length > 0) {
          const failedSet = Array.from(new Set(failed));
          parts.push(`⚠️ Could not remove: ${failedSet.join(', ')}`);
        }
        if (removed.length === 0 && failed.length === 0) parts.push('No changes made.');

        const message = parts.join('\n');

        await interaction.update({ content: message, components: [] });
        await updateSignupMessage(client, guildId);
        return;
      }

      if (interaction.customId === 'tzSelectNA' || interaction.customId === 'tzSelectEU') {
        const tz = interaction.values[0];
        setDefaultTz(guildId, tz);
        return interaction.update({ content: `✅ Default tournament time zone set to **${tz}**`, components: [] });
      }
    }

    // Modal Submits
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'setnickModal') {
        const nickname = interaction.fields.getTextInputValue('nickname').trim();
        
        // Validate nickname length
        if (nickname.length > 233) {
          return timedReply(interaction, { content: '❌ Nickname is too long! Maximum 233 characters allowed.' }, 10000);
        }
        
        setNickname(guildId, interaction.user.id, nickname);
        await updateSignupMessage(client, guildId); // Refresh the signup message with updated names
        return timedReply(interaction, { content: `✅ Nickname set to: ${nickname}` }, 10000);
      }

      if (interaction.customId === 'signupFriendsModal') {
        const namesRaw = interaction.fields.getTextInputValue('names');
        let names = namesRaw.split(/[\n,]+/).map(n => n.trim()).filter(Boolean).slice(0, 5);

        // Deduplicate within submission
        const seen = new Set();
        names = names.filter(n => {
          const low = n.toLowerCase();
          if (seen.has(low)) return false;
          seen.add(low);
          return true;
        });

        // Remove those already signed up globally
        const global = new Set(listPlayers(guildId).map(n => n.toLowerCase()));
        const newNames = names.filter(n => !global.has(n.toLowerCase()));

        if (newNames.length === 0) {
          return timedReply(interaction, { content: '⚠️ All of those names are already signed up (or were duplicates).' }, 30000);
        }

        addPlayers(guildId, interaction.user.id, newNames);
        await timedReply(interaction, { content: `✅ Friends signed up: ${newNames.join(', ')}` }, 10000);
        return updateSignupMessage(client, guildId);
      }

      if (interaction.customId === 'newTournamentModal') {
        try {
          // Acknowledge the interaction immediately to prevent timeout
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          const tname = interaction.fields.getTextInputValue('tname').trim();
          const tdate = interaction.fields.getTextInputValue('tdate').trim();
          const ttime = interaction.fields.getTextInputValue('ttime').trim();
          const ampm = interaction.fields.getTextInputValue('ampm').trim().toUpperCase();

          const tz = getDefaultTz(guildId);
          const [month, day, year] = tdate.split('-').map(n => parseInt(n, 10));
          const [hourRaw, minute] = ttime.split(':').map(n => parseInt(n, 10));

          let hour = hourRaw;
          if (ampm === 'PM' && hour !== 12) hour += 12;
          if (ampm === 'AM' && hour === 12) hour = 0;

          const fullYear = year < 100 ? 2000 + year : year;
          const dt = DateTime.fromObject({ year: fullYear, month, day, hour, minute }, { zone: tz });
          const unix = Math.floor(dt.toSeconds());

          // Clear existing tournament data when creating a new tournament
          clearPlayers(guildId);
          setState(guildId, 'challongeId', null);
          setState(guildId, 'challongeUrl', null);
          setState(guildId, 'bracket', null);
          
          setState(guildId, 'tournamentName', tname);
          setState(guildId, 'tournamentDate', dt.toISODate());
          setState(guildId, 'tournamentTime', `${dt.toFormat('MM-dd-yy hh:mm a ZZZZ')} (<t:${unix}:f>)`);
          setTournamentStatus(guildId, 'scheduled');

          await updateSignupMessage(client, guildId);
          
          return await interaction.editReply({
            content: `✅ Tournament **${tname}** scheduled for ${dt.toFormat('MM-dd-yy hh:mm a ZZZZ')} (<t:${unix}:f>)\n🗑️ Previous signups have been cleared for the new tournament.`
          });
        } catch (err) {
          console.error('Error creating tournament:', err);
          try {
            if (interaction.deferred) {
              return await interaction.editReply({
                content: '❌ Something went wrong creating the tournament. Please try again.'
              });
            } else {
              return await interaction.reply({
                content: '❌ Something went wrong creating the tournament. Please try again.',
                flags: MessageFlags.Ephemeral
              });
            }
          } catch (replyErr) {
            console.log('Could not send error reply:', replyErr);
          }
        }
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: '❓ Something went wrong handling that interaction.', flags: MessageFlags.Ephemeral });
      } catch (replyErr) {
        console.log('Could not send error reply (likely timeout)');
      }
    }
  }
});

// Add error handlers to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

// --- Start Bot ---
client.login(process.env.DISCORD_TOKEN);
