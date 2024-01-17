import { Client, GatewayIntentBits } from 'discord.js';
import { REST, Routes } from 'discord.js';
import 'dotenv/config';
import webhookListener from './webhooks/webhook_listener.js';
import OpenAI from 'openai';


const newCommands = {
  name: 'ask',
  description: 'Replies with Fire away!',
};

const commands = [
  {
    name: 'ping',
    description: 'Replies with Pong!',
  },
];

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PREFIX = 'sh!';
const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
const BOT_ID = process.env.BOT_ID;
const PREMIUM_CUTOFF = 10;
const LOG_CHANNEL_ID = '1194720201464348704';

const rest = new REST({ version: '10' }).setToken(TOKEN);

const updateCommands = async () => {
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    await rest.post(Routes.applicationCommands(CLIENT_ID), { body: newCommands });

    console.log('Successfully reloaded application (/) commands.');
  }
  catch (error) {
    console.error(error);
  }
};

if (parseInt(process.env.UPDATE_COMMANDS)) {
  updateCommands();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.DirectMessageTyping,
  ],
});

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply('Pong!');
  }

  if (interaction.commandName === 'ask') {
    const { user } = interaction;
    await interaction.reply('Fire away!');
    await user.createDM();
  }
});

const premiumRole = {
  name: 'Premium Member',
  color: 0x6aa84f,
  hoist: true,
};

async function updateMemberRoleForDonation(guild, member, donationAmount) {
  if (guild && member && donationAmount >= PREMIUM_CUTOFF) {
    let role = Array.from(await guild.roles.fetch()).find(
      (existingRole) => existingRole.name === premiumRole.name,
    );

    if (!role) {
      role = await guild.roles.create(premiumRole);
    }

    return await member.roles.add(role.id, 'Donated $10 or more.');
  }
}

const commandHandlerForCommandName = {};

commandHandlerForCommandName['addpayment'] = {
  botOwnerOnly: true,
  execute: async (msg, args) => {
    if (!msg.channel.guild) {
      return;
    }
    const mention = args[0];

    const amount = parseFloat(args[1]);
    const guild = msg.channel.guild;

    const userId = mention.replace(/<@(.*?)>/, (match, group1) => group1);
    const member = await guild.members.fetch(userId);

    const userIsInGuild = !!member;
    if (!userIsInGuild) {
      return msg.channel.send('User not found in this guild.');
    }

    const amountIsValid = amount && !Number.isNaN(amount);
    if (!amountIsValid) {
      return msg.channel.send('Invalid donation amount');
    }
    return Promise.all([
      msg.channel.send(`${mention} paid $${amount.toFixed(2)}`),
      updateMemberRoleForDonation(guild, member, amount),
    ]);
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let userInfo = {
  user: '',
  conversationArr: [],
};

const fetchReply = async function(message, user) {
  const { user: currentUser, conversationArr } = userInfo;
  // Different user, reset the context
  if (user.id !== currentUser) {
    userInfo = {
      user: user.id,
      conversationArr: [],
    };
  }
  conversationArr.push({
    role: 'user',
    content: message,
  });
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: conversationArr,
  });

  conversationArr.push(response.choices[0].message);
  return response.choices[0].message.content;
};


client.on('messageCreate', async (msg) => {
  const content = msg.content;

  const parts = content
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s);
  const commandName = parts[0].substr(PREFIX.length);

  const command = commandHandlerForCommandName[commandName];

  const user = msg.author;

  if (user.id === BOT_ID) {
    return;
  }

  if (!content.startsWith(PREFIX) && !command) {
    // call ChatGPT
    const reply = await fetchReply(content, user);
    return await msg.channel.send(reply);
  }

  const authorIsBotOwner = msg.author.id === BOT_OWNER_ID;
  if (command.botOwnerOnly && !authorIsBotOwner) {
    return await msg.channel.send('Hey, only my owner can issue that command!');
  }

  const args = parts.slice(1);

  try {
    await command.execute(msg, args);
  }
  catch (err) {
    console.warn('Error handling command');
    console.warn(err);
  }
});

client.on('guildMemberAdd', async (member) => {
  const channel = member.guild.channels.cache.find(
    (ch) => ch.name === 'general',
  );
  if (!channel) return;
  channel.send(`Welcome ${member}!`);
});

client.on('error', (err) => {
  console.warn(err);
});

async function findUserInString(str) {
  const lowercaseStr = str.toLowerCase();
  const guilds = await client.guilds.cache;

  let user,
    guild = null;
  await Promise.all(
    guilds.map(async (currGuild) => {
      const members = await currGuild.members.fetch();

      members.map(async (member) => {
        if (
          lowercaseStr.indexOf(
            `${member.user.username.toLowerCase()}#${member.user.discriminator}`,
          ) !== -1
        ) {
          user = member;
          guild = currGuild;
        }
      });
    }),
  );

  return { user, guild };
}

function logDonation(
  member,
  donationAmount,
  paymentSource,
  paymentId,
  senderName,
  message,
  timestamp,
) {
  const isKnownMember = !!member;
  const memberName = isKnownMember
    ? `${member.username}#${member.discriminator}`
    : 'Unknown';
  const embedColor = isKnownMember ? 0x00ff00 : 0xff0000;

  const logMessage = {
    embed: {
      title: 'Donation received',
      color: embedColor,
      timestamp: timestamp,
      fields: [
        { name: 'Payment Source', value: paymentSource, inline: true },
        { name: 'Payment ID', value: paymentId, inline: true },
        { name: 'Sender', value: senderName, inline: true },
        { name: 'Donor Discord name', value: memberName, inline: true },
        {
          name: 'Donation amount',
          value: donationAmount.toString(),
          inline: true,
        },
        { name: 'Message', value: message, inline: true },
      ],
    },
  };

  client.createMessage(LOG_CHANNEL_ID, logMessage);
}

async function onDonation(
  paymentSource,
  paymentId,
  timestamp,
  amount,
  senderName,
  message,
) {
  try {
    const { user, guild } = await findUserInString(message);
    const guildMember = guild ? await guild.members.fetch(user.id) : null;

    return await Promise.all([
      updateMemberRoleForDonation(guild, guildMember, amount),
      logDonation(
        guildMember,
        amount,
        paymentSource,
        paymentId,
        senderName,
        message,
        timestamp,
      ),
    ]);
  }
  catch (err) {
    console.warn('Error handling donation event.');
    console.warn(err);
  }
}

webhookListener.on('donation', onDonation);

client.login(TOKEN);
