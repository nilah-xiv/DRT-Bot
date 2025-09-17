require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  Events
} = require('discord.js');
const { DateTime } = require('luxon');
const {
  setState, getState,
  addPlayers, removePlayers, listPlayers,
  clearPlayers, setNickname, getNickname,
  listUserPlayers,            // ✅ import this
} = require('./db');

// --- Client Setup ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

const CHANNEL_ID = process.env.CHANNEL_ID;
const OWNER_ROLE = process.env.OWNER_ROLE_ID;
const STAFF_ROLE = process.env.STAFF_ROLE_ID;
const CHALLONGE_API_KEY = process.env.CHALLONGE_API_KEY;

// --- Challonge API ---
async function createTournament(tournamentName) {
  const resp = await fetch('https://api.challonge.com/v1/tournaments.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHALLONGE_API_KEY}`,
    },
    body: JSON.stringify({
      tournament: {
        name: tournamentName,
        tournament_type: 'single elimination',
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Challonge API error: ${resp.status} ${text}`);
  }

  return resp.json();
}

// --- Signup Message ---
async function postSignupMessage(channel) {
  const players = listPlayers();
  const tname = getState('tournamentName') || 'Death Roll Tournament';
  const ttime = getState('tournamentTime') || 'TBD';

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('signup').setLabel('Sign Me Up').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setnick').setLabel('Set Nickname').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('signupfriends').setLabel('Sign Up Friends').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('withdraw').setLabel('Withdraw').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('list').setLabel('List Players').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adminpanel').setLabel('Admin Panel').setStyle(ButtonStyle.Primary),
  );

  const msg = await channel.send({
    content: `**${tname}**\nScheduled: ${ttime}\nCurrent signups: **${players.length}**`,
    components: [row1, row2],
  });

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

  await msg.edit({
    content: `**${tname}**\nScheduled: ${ttime}\nCurrent signups: **${players.length}**`,
    components: msg.components,
  });
}

// --- Bot Startup ---
client.once(Events.ClientReady, async () => { // ✅ proper ready event
  console.log(`Logged in as ${client.user.tag}`);
  const channel = await client.channels.fetch(CHANNEL_ID);

  const channelId = getState('signupChannelId');
  const messageId = getState('signupMessageId');
  try {
    if (channelId && messageId) {
      await updateSignupMessage(client);
      console.log('Reusing existing signup message');
    } else {
      await postSignupMessage(channel);
      console.log('Posted fresh signup message');
    }
  } catch (err) {
    console.error('Startup error:', err);
    await postSignupMessage(channel);
    console.log('Posted new signup message after error');
  }
});

// --- Interactions ---
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // --- Buttons ---
    if (interaction.isButton()) {
      // --- Sign up ---
      if (interaction.customId === 'signup') {
        const nick = getNickname(interaction.user.id);
        const displayName = nick || interaction.member?.displayName || interaction.user.username;
        addPlayers(interaction.user.id, [displayName]);
        await interaction.reply({ content: `✅ Signed up: ${displayName}`, flags: 64 });
        return updateSignupMessage(client);
      }

      // --- Nickname ---
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

      // --- Friends ---
      if (interaction.customId === 'signupfriends') {
        console.log('Sign Up Friends button clicked'); // ✅ debug
        const modal = new ModalBuilder()
          .setCustomId('signupFriendsModal')
          .setTitle('Sign Up Friends');

        const input = new TextInputBuilder()
          .setCustomId('names')
              .setLabel('Enter up to 5 names')         
				.setPlaceholder('Comma or newline separated') 
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      // --- Withdraw ---
     if (interaction.customId === 'withdraw') {
  const mine = listUserPlayers(interaction.user.id);
  if (mine.length === 0) {
    return interaction.reply({ content: 'ℹ️ You have no signups to withdraw.', flags: 64 });
  }

  const placeholderRaw = `Yours: ${mine.join(', ')}`;
  const placeholder = placeholderRaw.length > 95 ? placeholderRaw.slice(0, 95) + '…' : placeholderRaw;

  const modal = new ModalBuilder()
    .setCustomId('withdrawModal')
    .setTitle('Withdraw');

  const input = new TextInputBuilder()
    .setCustomId('names')
    .setLabel('Which player(s)?')   // ✅ <= 45 chars
    .setPlaceholder(placeholder)    // names shown here
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
  return;
}


      // --- List Players ---
      if (interaction.customId === 'list') {
        const hasRole = interaction.member.roles.cache.has(OWNER_ROLE) || interaction.member.roles.cache.has(STAFF_ROLE);
        if (!hasRole) return interaction.reply({ content: '🚫 Not allowed.', flags: 64 });

        const players = listPlayers();
        if (players.length === 0) return interaction.reply({ content: '📭 No signups yet.', flags: 64 });

        const formatted = players.map((p, i) => `${i + 1}. ${p}`).join('\n');
        return interaction.reply({ content: `**Signups (${players.length})**\n${formatted}`, flags: 64 });
      }

      // --- Admin Panel toggle ---
      if (interaction.customId === 'adminpanel') {
        const hasRole = interaction.member.roles.cache.has(OWNER_ROLE) || interaction.member.roles.cache.has(STAFF_ROLE);
        if (!hasRole) {
          return interaction.reply({ content: '🚫 Not allowed.', flags: 64 });
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('start').setLabel('Start Bracket').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('newtournament').setLabel('New Tournament').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('createbracket').setLabel('Create Bracket (Challonge)').setStyle(ButtonStyle.Primary),
        );

        return interaction.reply({ content: '⚙️ **Admin Controls**', components: [row], flags: 64 });
      }

      // --- Admin Controls ---
      if (interaction.customId === 'start') {
        if (!interaction.member.roles.cache.has(OWNER_ROLE)) {
          return interaction.reply({ content: '🚫 Only Owners can start.', flags: 64 });
        }
        const players = listPlayers();
        if (players.length < 2) return interaction.reply({ content: '⚠️ Not enough players.', flags: 64 });

        clearPlayers();
        await updateSignupMessage(client);
        return interaction.reply(`🚀 Bracket started with ${players.length} players.`);
      }

      if (interaction.customId === 'newtournament') {
        if (!interaction.member.roles.cache.has(OWNER_ROLE)) {
          return interaction.reply({ content: '🚫 Only Owners can start a new tournament.', flags: 64 });
        }
        const modal = new ModalBuilder()
          .setCustomId('newTournamentModal')
          .setTitle('New Tournament');

        const nameInput = new TextInputBuilder()
          .setCustomId('tname')
          .setLabel('Tournament name')
          .setStyle(TextInputStyle.Short)
          .setValue('Death Roll Tournament')
          .setRequired(true);

        const dateInput = new TextInputBuilder()
          .setCustomId('tdate')
          .setLabel('Date (MM-DD-YY)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(nameInput),
          new ActionRowBuilder().addComponents(dateInput),
        );

        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === 'createbracket') {
        if (!interaction.member.roles.cache.has(OWNER_ROLE)) {
          return interaction.reply({ content: '🚫 Only Owners can create brackets.', flags: 64 });
        }
        try {
          const tname = getState('tournamentName') || 'Death Roll Tournament';
          const data = await createTournament(tname);
          return interaction.reply({
            content: `✅ Tournament created on Challonge!\nURL: ${data.tournament.full_challonge_url}`,
            flags: 64,
          });
        } catch (err) {
          console.error(err);
          return interaction.reply({ content: `❌ Failed: ${err.message}`, flags: 64 });
        }
      }
    }

    // --- Modal Submits ---
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'setnickModal') {
        const nickname = interaction.fields.getTextInputValue('nickname').trim();
        setNickname(interaction.user.id, nickname);
        return interaction.reply({ content: `✅ Nickname set to: ${nickname}`, flags: 64 });
      }

      if (interaction.customId === 'signupFriendsModal') {
        const names = interaction.fields.getTextInputValue('names')
          .split(/[\n,]+/)
          .map((n) => n.trim())
          .filter(Boolean)
          .slice(0, 5);
        addPlayers(interaction.user.id, names);
        await interaction.reply({ content: `✅ Friends signed up: ${names.join(', ')}`, flags: 64 });
        return updateSignupMessage(client);
      }

      if (interaction.customId === 'withdrawModal') {
        const allMine = listUserPlayers(interaction.user.id);
        const requested = interaction.fields.getTextInputValue('names')
          .split(/[\n,]+/)
          .map((n) => n.trim())
          .filter(Boolean);

        const valid = requested.filter((n) => allMine.includes(n));
        if (valid.length === 0) {
          return interaction.reply({ content: '⚠️ None of those names match your signups.', flags: 64 });
        }

        removePlayers(interaction.user.id, valid);
        await interaction.reply({ content: `🔴 Removed: ${valid.join(', ')}`, flags: 64 });
        return updateSignupMessage(client);
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    // Try to let the user know instead of timing out
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      try { await interaction.reply({ content: '❌ Something went wrong handling that interaction.', flags: 64 }); } catch {}
    }
  }
});

// --- Start Bot ---
client.login(process.env.DISCORD_TOKEN);
