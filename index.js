require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  Events, MessageFlags,
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
  const guildId = process.env.GUILD_ID;
  const appId = (await client.application?.fetch())?.id;
  if (!guildId) {
    console.error('GUILD_ID is not set in your .env file. Please set it to your server ID.');
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
    // Register only as a guild command
    await rest.put(
      Routes.applicationGuildCommands(appId, guildId),
      { body: commands }
    );
    console.log('Registered /drtadmin as a guild command');
  } catch (err) {
    console.error('Failed to register/cleanup slash command:', err);
  }
}
const { DateTime } = require('luxon');
const fetch = require('node-fetch');
const {
  setState, getState,
  addPlayers, removePlayers, listPlayers,
  clearPlayers, setNickname, getNickname,
  listUserPlayers,
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
function buildSignupRows(status) {
  if (status === 'none') {
    // Only show the Interact button
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('interact').setLabel('Interact').setStyle(ButtonStyle.Primary)
    );
    return [row];
  } else {
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
      const challongeUrl = getState('challongeUrl');
      if (challongeUrl) {
        row.addComponents(
          new ButtonBuilder().setLabel('View Bracket').setStyle(ButtonStyle.Link).setURL(challongeUrl)
        );
      }
    }
    return [row];
  }
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
async function postSignupMessage(channel) {
  const players = listPlayers();
  const tname = getState('tournamentName') || 'Death Roll Tournament';
  const ttime = getState('tournamentTime') || 'TBD';
  const status = getTournamentStatus();

  let content;
  if (status === 'none') {
    content = '⚔️ Death Roll signups are not open. An admin must create a tournament to begin.';
  } else if (status === 'scheduled') {
    content = `⚔️ **${tname}**\nScheduled: ${ttime}\nCurrent signups: **${players.length}**`;
  } else {
    const challongeUrl = getState('challongeUrl');
    if (challongeUrl) {
      // Get current match info for live tournaments
      const challongeId = getState('challongeId');
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

  const rows = buildSignupRows(status);

  const msg = await channel.send({ content, components: rows });
  setState('signupMessageId', msg.id);
  setState('signupChannelId', channel.id);
  return msg;
}

// --- Update Signup Message ---
async function updateSignupMessage(client) {
  const messageId = getState('signupMessageId');
  const channelId = getState('signupChannelId');
  if (!messageId || !channelId) return;

  const channel = await client.channels.fetch(channelId);
  const msg = await channel.messages.fetch(messageId);
  const players = listPlayers();
  const tname = getState('tournamentName') || 'Death Roll Tournament';
  const ttime = getState('tournamentTime') || 'TBD';
  const status = getTournamentStatus();

  let content;
  if (status === 'none') {
    content = '⚔️ Death Roll signups are not open. An admin must create a tournament to begin.';
  } else if (status === 'scheduled') {
    content = `⚔️ **${tname}**\nScheduled: ${ttime}\nCurrent signups: **${players.length}**`;
  } else {
    const challongeUrl = getState('challongeUrl');
    if (challongeUrl) {
      // Get current match info for live tournaments
      const challongeId = getState('challongeId');
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

  const rows = buildSignupRows(status);
  await msg.edit({ content, components: rows });
}

// --- Helper Function for Timed Replies ---
// Note: True ephemeral messages can't be deleted programmatically.
// This helper standardizes private replies without timers to avoid API warnings.
async function timedReply(interaction, options, duration = 10000) {
  return interaction.reply({ ...options, flags: MessageFlags.Ephemeral });
}

// --- End Existing Bracket ---
async function endExistingBracket(interaction) {
  const existingId = getState('challongeId');
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
      setState('challongeId', null);
      setState('challongeUrl', null);
      setTournamentStatus('none');
      await updateSignupMessage(client);
      return timedReply(interaction, { content: '✅ Bracket is already complete. Cleared saved bracket and reset status.' }, 30000);
    }

    // 3) Try to finalize if not yet complete
    const finRes = await fetch(`https://api.challonge.com/v1/tournaments/${existingId}/finalize.json?api_key=${process.env.CHALLONGE_API_KEY}`, {
      method: 'POST'
    });

    if (!finRes.ok) {
      const errText = await finRes.text();
      // Fallback: clear local state even if Challonge refuses finalize (e.g., missing scores)
      setState('challongeId', null);
      setState('challongeUrl', null);
      setTournamentStatus('none');
      await updateSignupMessage(client);
      return timedReply(
        interaction,
        { content: `⚠️ Could not finalize on Challonge (${errText.trim()}). Cleared saved bracket locally so you can create a new one.` },
        30000
      );
    }

    // 4) Finalized successfully
    setState('challongeId', null);
    setState('challongeUrl', null);
    setTournamentStatus('none');
    await updateSignupMessage(client);
    return timedReply(interaction, { content: '✅ Bracket finalized on Challonge and cleared locally.' }, 30000);
  } catch (err) {
    console.error('Error finalizing bracket:', err);
    // Fallback: clear locally so workflow can continue
    setState('challongeId', null);
    setState('challongeUrl', null);
    setTournamentStatus('none');
    try { await updateSignupMessage(client); } catch {}
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
  const channel = await client.channels.fetch(CHANNEL_ID);

  // Register slash commands
  await registerSlashCommands();

  try {
    const messageId = getState('signupMessageId');
    if (messageId) {
      try {
        const oldMsg = await channel.messages.fetch(messageId);
        await oldMsg.delete();
      } catch {}
    }
    await postSignupMessage(channel);
    console.log('Posted signup message based on tournament status');
  } catch (err) {
    console.error('Startup error:', err);
    await postSignupMessage(channel);
  }

  // Start periodic updates for current match info
  setInterval(async () => {
    try {
      const status = getTournamentStatus();
      if (status === 'in-progress') {
        await updateSignupMessage(client);
      }
    } catch (error) {
      console.error('Error updating current match:', error);
    }
  }, 5000); // Update every 5 seconds
});

// --- Interactions ---
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // --- Handle /drtadmin slash command ---
    if (interaction.isChatInputCommand && interaction.commandName === 'drtadmin') {
      const hasOwnerRole = interaction.member?.roles?.cache?.has(OWNER_ROLE);
      const hasStaffRole = STAFF_ROLE && interaction.member?.roles?.cache?.has(STAFF_ROLE);
      const isAdmin = hasOwnerRole || hasStaffRole;
      
      if (!isAdmin) {
        return interaction.reply({ content: '❌ Not allowed.', ephemeral: true });
      }
      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('start').setLabel('Start Bracket').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('newtournament').setLabel('New Tournament').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('createbracket').setLabel('Create Bracket').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('settz').setLabel('Set Default Time Zone').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('endbracket').setLabel('End Bracket').setStyle(ButtonStyle.Danger)
      );
      const components = [row1];
      const challongeUrl = getState('challongeUrl');
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
        console.log('Could not reply to /drtadmin command (likely timeout)');
      }
    }

    if (interaction.isButton()) {
      // Interact button handler
      if (interaction.customId === 'interact') {
        const status = getTournamentStatus();
        const hasOwnerRole = interaction.member?.roles?.cache?.has(OWNER_ROLE);
        const hasStaffRole = STAFF_ROLE && interaction.member?.roles?.cache?.has(STAFF_ROLE);
        const isAdmin = hasOwnerRole || hasStaffRole;
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
        if (getTournamentStatus() !== 'scheduled') {
          return timedReply(interaction, { content: 'Signups are closed right now.' }, 30000);
        }
        const nick = getNickname(interaction.user.id);
        const displayName = nick || interaction.member?.displayName || interaction.user.username;

        const existing = listPlayers();
        if (existing.includes(displayName)) {
          return timedReply(interaction, { content: `⚠️ You're already signed up as **${displayName}**.` }, 30000);
        }

        addPlayers(interaction.user.id, [displayName]);
        await timedReply(interaction, { content: `✅ Signed up: ${displayName}` }, 10000);
        return updateSignupMessage(client);
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
        if (getTournamentStatus() !== 'scheduled') {
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
        const mine = listUserPlayers(interaction.user.id);
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
        const mine = listUserPlayers(interaction.user.id);
        if (mine.length === 0) {
          return interaction.update({ content: '❌ Nothing to withdraw.', components: [] });
        }
        removePlayers(interaction.user.id, mine);
        await interaction.update({ content: '✅ All your signups have been withdrawn.', components: [] });
        return updateSignupMessage(client);
      }

      // List Players
      if (interaction.customId === 'list') {
        const players = listPlayers();
        if (players.length === 0) return timedReply(interaction, { content: '📝 No signups yet.' }, 30000);
        const formatted = players.map((p, i) => `${i + 1}. ${p}`).join('\n');
        return timedReply(interaction, { content: `**Signups (${players.length})**\n${formatted}` }, 30000);
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

      // New Tournament
      if (interaction.customId === 'newtournament') {
        // Check if there's already an active tournament
        const currentStatus = getTournamentStatus();
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
        const isOwner = interaction.member.roles.cache.has(OWNER_ROLE);
        if (!isOwner) return timedReply(interaction, { content: '❌ Only Owners can create brackets.' }, 30000);

        if (getTournamentStatus() !== 'scheduled') {
          return timedReply(interaction, { content: '❌ No scheduled tournament to create a bracket for.' }, 30000);
        }

        const existingId = getState('challongeId');
        if (existingId) {
          const url = getState('challongeUrl');
          return timedReply(interaction, { content: `⚠️ A Challonge tournament already exists.\n${url ?? '(no url saved)'}` }, 30000);
        }

        const players = listPlayers();
        if (players.length < 2) {
          return timedReply(interaction, { content: '❌ Not enough players to create a bracket.' }, 30000);
        }

        const tname = getState('tournamentName') || 'Death Roll Tournament';
        const ttime = getState('tournamentTime') || 'TBD';
        const bracket = { name: tname, time: ttime, players: [...players], createdAt: new Date().toISOString() };
        setState('bracket', bracket);

        try {
          const tourn = await pushToChallonge(bracket);
          setState('challongeId', tourn.id);
          setState('challongeUrl', tourn.full_challonge_url);

          await interaction.reply({
            content: `🏆 Bracket created on Challonge for **${tname}** with ${players.length} players.\n${tourn.full_challonge_url}`,
            flags: MessageFlags.Ephemeral
          });

          const channel = await client.channels.fetch(getState('signupChannelId'));
          await channel.send(`🏆 Bracket for **${tname}** is live!\n${tourn.full_challonge_url}`);
        } catch (err) {
          console.error(err);
          return timedReply(interaction, { content: `❌ Failed to create Challonge tournament: ${err.message}` }, 30000);
        }
      }

      // Start Bracket
      if (interaction.customId === 'start') {
        const isOwner = interaction.member.roles.cache.has(OWNER_ROLE);
  if (!isOwner) return interaction.reply({ content: '❌ Only Owners can start the bracket.', flags: MessageFlags.Ephemeral });

        const tid = getState('challongeId');
  if (!tid) return interaction.reply({ content: '❌ No Challonge tournament created yet.', flags: MessageFlags.Ephemeral });

        try {
          await startChallongeTournament(tid);
          clearPlayers();
          setTournamentStatus('in-progress');
          await updateSignupMessage(client);
          return interaction.reply({ content: '🏆 Tournament started on Challonge!', flags: MessageFlags.Ephemeral });
        } catch (err) {
          console.error(err);
          return interaction.reply({ content: `❌ Failed to start: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
      }

      // End Bracket
      if (interaction.customId === 'endbracket') {
        return endExistingBracket(interaction);
      }
    }

    // Select Menus
       if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'withdrawSelect') {
        const selected = interaction.values.map(v => v.split('-')[0]); // strip index
        removePlayers(interaction.user.id, selected);
        await timedReply(interaction, { content: `🗑️ Removed: ${selected.join(', ')}` }, 10000);
        return updateSignupMessage(client);
      }

      if (interaction.customId === 'tzSelectNA' || interaction.customId === 'tzSelectEU') {
        const tz = interaction.values[0];
        setDefaultTz(tz);
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
        
        setNickname(interaction.user.id, nickname);
        await updateSignupMessage(client); // Refresh the signup message with updated names
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
        const global = new Set(listPlayers().map(n => n.toLowerCase()));
        const newNames = names.filter(n => !global.has(n.toLowerCase()));

        if (newNames.length === 0) {
          return timedReply(interaction, { content: '⚠️ All of those names are already signed up (or were duplicates).' }, 30000);
        }

        addPlayers(interaction.user.id, newNames);
        await timedReply(interaction, { content: `✅ Friends signed up: ${newNames.join(', ')}` }, 10000);
        return updateSignupMessage(client);
      }

      if (interaction.customId === 'newTournamentModal') {
        try {
          // Acknowledge the interaction immediately to prevent timeout
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          const tname = interaction.fields.getTextInputValue('tname').trim();
          const tdate = interaction.fields.getTextInputValue('tdate').trim();
          const ttime = interaction.fields.getTextInputValue('ttime').trim();
          const ampm = interaction.fields.getTextInputValue('ampm').trim().toUpperCase();

          const tz = getDefaultTz();
          const [month, day, year] = tdate.split('-').map(n => parseInt(n, 10));
          const [hourRaw, minute] = ttime.split(':').map(n => parseInt(n, 10));

          let hour = hourRaw;
          if (ampm === 'PM' && hour !== 12) hour += 12;
          if (ampm === 'AM' && hour === 12) hour = 0;

          const fullYear = year < 100 ? 2000 + year : year;
          const dt = DateTime.fromObject({ year: fullYear, month, day, hour, minute }, { zone: tz });
          const unix = Math.floor(dt.toSeconds());

          // Clear existing tournament data when creating a new tournament
          clearPlayers();
          setState('challongeId', null);
          setState('challongeUrl', null);
          setState('bracket', null);
          
          setState('tournamentName', tname);
          setState('tournamentDate', dt.toISODate());
          setState('tournamentTime', `${dt.toFormat('MM-dd-yy hh:mm a ZZZZ')} (<t:${unix}:f>)`);
          setTournamentStatus('scheduled');

          await updateSignupMessage(client);
          
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
