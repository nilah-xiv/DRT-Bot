require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  Events, MessageFlags
} = require('discord.js');
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
    return { label: `${z} (${offset}) – ${timeNow}`, value: z };
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
  const row1 = new ActionRowBuilder();
  if (status === 'scheduled') {
    row1.addComponents(
      new ButtonBuilder().setCustomId('signup').setLabel('Sign Me Up').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('setnick').setLabel('Set Nickname').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('signupfriends').setLabel('Sign Up Friends').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('withdraw').setLabel('Withdraw').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('list').setLabel('List Players').setStyle(ButtonStyle.Secondary),
    );
  } else if (status === 'in-progress') {
    row1.addComponents(
      new ButtonBuilder().setCustomId('setnick').setLabel('Set Nickname').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('list').setLabel('List Players').setStyle(ButtonStyle.Secondary),
    );
  } else {
    row1.addComponents(
      new ButtonBuilder().setCustomId('setnick').setLabel('Set Nickname').setStyle(ButtonStyle.Secondary),
    );
  }

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adminpanel').setLabel('Admin Panel').setStyle(ButtonStyle.Primary)
  );

  return [row1, row2];
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

// --- Signup Message ---
async function postSignupMessage(channel) {
  const players = listPlayers();
  const tname = getState('tournamentName') || 'Death Roll Tournament';
  const ttime = getState('tournamentTime') || 'TBD';
  const status = getTournamentStatus();

  let content;
  if (status === 'none') {
    content = '⚠️ Death Roll signups are not open. An admin must create a tournament to begin.';
  } else if (status === 'scheduled') {
    content = `**${tname}**\nScheduled: ${ttime}\nCurrent signups: **${players.length}**`;
  } else {
    content = `**${tname}**\n🔥 Tournament in progress...`;
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
    content = '⚠️ Death Roll signups are not open. An admin must create a tournament to begin.';
  } else if (status === 'scheduled') {
    content = `**${tname}**\nScheduled: ${ttime}\nCurrent signups: **${players.length}**`;
  } else {
    content = `**${tname}**\n🔥 Tournament in progress...`;
  }

  const rows = buildSignupRows(status);
  await msg.edit({ content, components: rows });
}

// --- Helper Function for Timed Replies ---
async function timedReply(interaction, options, duration = 10000) {
  const msg = await interaction.reply({ ...options, flags: MessageFlags.Ephemeral, withResponse: true });
  setTimeout(() => {
    if (msg.deletable) msg.delete().catch(() => {});
  }, duration);
}

// --- Bot Startup ---
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const channel = await client.channels.fetch(CHANNEL_ID);

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
});

// --- Interactions ---
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      // Sign up
      if (interaction.customId === 'signup') {
        if (getTournamentStatus() !== 'scheduled') {
          return timedReply(interaction, { content: 'Signups are closed right now.' }, 30000);
        }
        const nick = getNickname(interaction.user.id);
        const displayName = nick || interaction.member?.displayName || interaction.user.username;

        const existing = listPlayers();
        if (existing.includes(displayName)) {
          return timedReply(interaction, { content: `⚠️ You’re already signed up as **${displayName}**.` }, 30000);
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
          .setLabel('Enter your nickname')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
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
          return timedReply(interaction, { content: 'ℹ️ You have no signups to withdraw.' }, 30000);
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
            content: '📝 Select players to withdraw, or click **Withdraw All**:',
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
          return interaction.update({ content: 'ℹ️ Nothing to withdraw.', components: [] });
        }
        removePlayers(interaction.user.id, mine);
        await interaction.update({ content: '🔴 All your signups have been withdrawn.', components: [] });
        return updateSignupMessage(client);
      }

      // List Players
      if (interaction.customId === 'list') {
        const players = listPlayers();
        if (players.length === 0) return timedReply(interaction, { content: '📭 No signups yet.' }, 30000);
        const formatted = players.map((p, i) => `${i + 1}. ${p}`).join('\n');
        return timedReply(interaction, { content: `**Signups (${players.length})**\n${formatted}` }, 30000);
      }

      // Admin Panel
      if (interaction.customId === 'adminpanel') {
        const hasRole = interaction.member.roles.cache.has(OWNER_ROLE) || interaction.member.roles.cache.has(STAFF_ROLE);
        if (!hasRole) return timedReply(interaction, { content: '🚫 Not allowed.' }, 30000);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('start').setLabel('Start Bracket').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('newtournament').setLabel('New Tournament').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('createbracket').setLabel('Create Bracket').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('settz').setLabel('Set Default Time Zone').setStyle(ButtonStyle.Secondary)
        );

        const challongeUrl = getState('challongeUrl');
        if (challongeUrl) {
          row.addComponents(new ButtonBuilder().setLabel('View Bracket').setStyle(ButtonStyle.Link).setURL(challongeUrl));
        }

        await interaction.reply({
          content: '⚙️ **Admin Controls**',
          components: [row],
          flags: MessageFlags.Ephemeral
        });
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
          content: '🌐 Please select a default time zone for tournaments:',
          components: [new ActionRowBuilder().addComponents(naMenu), new ActionRowBuilder().addComponents(euMenu)],
          ephemeral: true
        });
      }

      // New Tournament
      if (interaction.customId === 'newtournament') {
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

        return interaction.showModal(modal);
      }

      // Create Bracket
      if (interaction.customId === 'createbracket') {
        const isOwner = interaction.member.roles.cache.has(OWNER_ROLE);
        if (!isOwner) return timedReply(interaction, { content: '🚫 Only Owners can create brackets.' }, 30000);

        if (getTournamentStatus() !== 'scheduled') {
          return timedReply(interaction, { content: '⚠️ No scheduled tournament to create a bracket for.' }, 30000);
        }

        const existingId = getState('challongeId');
        if (existingId) {
          const url = getState('challongeUrl');
          return timedReply(interaction, { content: `ℹ️ A Challonge tournament already exists.\n${url ?? '(no url saved)'}` }, 30000);
        }

        const players = listPlayers();
        if (players.length < 2) {
          return timedReply(interaction, { content: '⚠️ Not enough players to create a bracket.' }, 30000);
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
            content: `✅ Bracket created on Challonge for **${tname}** with ${players.length} players.\n${tourn.full_challonge_url}`,
            flags: MessageFlags.Ephemeral
          });

          const channel = await client.channels.fetch(getState('signupChannelId'));
          await channel.send(`📣 Bracket for **${tname}** is live!\n${tourn.full_challonge_url}`);
        } catch (err) {
          console.error(err);
          return timedReply(interaction, { content: `❌ Failed to create Challonge tournament: ${err.message}` }, 30000);
        }
      }

      // Start Bracket
      if (interaction.customId === 'start') {
        const isOwner = interaction.member.roles.cache.has(OWNER_ROLE);
        if (!isOwner) return interaction.reply({ content: '🚫 Only Owners can start the bracket.', ephemeral: true });

        const tid = getState('challongeId');
        if (!tid) return interaction.reply({ content: '⚠️ No Challonge tournament created yet.', ephemeral: true });

        try {
          await startChallongeTournament(tid);
          clearPlayers();
          setTournamentStatus('in-progress');
          await updateSignupMessage(client);
          return interaction.reply({ content: '🚀 Tournament started on Challonge!', ephemeral: true });
        } catch (err) {
          console.error(err);
          return interaction.reply({ content: `❌ Failed to start: ${err.message}`, ephemeral: true });
        }
      }
    }

    // Select Menus
       if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'withdrawSelect') {
        const selected = interaction.values.map(v => v.split('-')[0]); // strip index
        removePlayers(interaction.user.id, selected);
        await timedReply(interaction, { content: `🔴 Removed: ${selected.join(', ')}` }, 10000);
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
        setNickname(interaction.user.id, nickname);
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

        setState('tournamentName', tname);
        setState('tournamentDate', dt.toISODate());
        setState('tournamentTime', `${dt.toFormat('MM-dd-yy hh:mm a ZZZZ')} (<t:${unix}:f>)`);
        setTournamentStatus('scheduled');

        await updateSignupMessage(client);
        return interaction.reply({
          content: `✅ Tournament **${tname}** scheduled for ${dt.toFormat('MM-dd-yy hh:mm a ZZZZ')} (<t:${unix}:f>)`,
          ephemeral: true
        });
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: '❌ Something went wrong handling that interaction.', ephemeral: true });
      } catch {}
    }
  }
});

// --- Start Bot ---
client.login(process.env.DISCORD_TOKEN);
