require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActivityType,
  Collection,
  ChannelType,
  EmbedBuilder,
} = require("discord.js");
const cron = require("node-cron");
const db = require("./database");
const {
  buildLeaderboardEmbed,
  buildRankEmbed,
  getRankTitle,
  buildPointSystemEmbed,
  buildTop20Embed,
  buildCommandsEmbed,
} = require("./embeds");
const config = require("./config");

// ─── Client Setup ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ─── Runtime state ────────────────────────────────────────────────────────────
const messageCooldowns  = new Collection(); // userId → last award ms
const reactionCooldowns = new Collection(); // userId → last award ms
const dailyFirstMessage = new Collection(); // userId → "YYYY-MM-DD"
const voiceSessions     = new Collection(); // userId → join timestamp ms

// Cached message IDs for the three pinned ranking embeds.
// Populated on first post/rediscover; lets us edit-in-place without scanning.
const rankingMsgIds = { header: null, leaderboard: null, commands: null };

// ─── Slash Command Definitions ────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("View server rankings or check a specific user's rank card")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("Check a specific user's rank card").setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("top (default) or last")
        .setRequired(false)
        .addChoices({ name: "top", value: "top" }, { name: "last", value: "last" })
    )
    .addIntegerOption((opt) =>
      opt
        .setName("count")
        .setDescription("Number of users to show (1–500, default 10)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(500)
    ),

  new SlashCommandBuilder()
    .setName("addpoints")
    .setDescription("Manually add points to a user (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) => opt.setName("user").setDescription("Target user").setRequired(true))
    .addNumberOption((opt) =>
      opt.setName("amount").setDescription("Points to add").setRequired(true).setMinValue(1)
    )
    .addStringOption((opt) =>
      opt.setName("reason").setDescription("Reason (e.g. 'Solved Challenge #12')").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("deductpoints")
    .setDescription("Deduct points from a user (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) => opt.setName("user").setDescription("Target user").setRequired(true))
    .addNumberOption((opt) =>
      opt.setName("amount").setDescription("Points to deduct").setRequired(true).setMinValue(1)
    )
    .addStringOption((opt) =>
      opt.setName("reason").setDescription("Reason").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("history")
    .setDescription("View recent point activity on the server"),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View the current leaderboard"),
].map((cmd) => cmd.toJSON());

// ─── Register Slash Commands ──────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log("Registering slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// ─── Ensure #ranking channel exists ──────────────────────────────────────────
async function ensureRankingChannel(guild) {
  let channel = null;

  if (process.env.RANKING_CHANNEL_ID) {
    try {
      channel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
    } catch {}
  }

  if (!channel) {
    channel =
      guild.channels.cache.find(
        (c) => c.name === "ranking" && c.type === ChannelType.GuildText
      ) || null;
  }

  if (!channel) {
    channel = await guild.channels.create({
      name: "ranking",
      type: ChannelType.GuildText,
      topic: "🏆 Server leaderboard & points system — use /rank, /history, /leaderboard here",
    });
    console.log(`✅ Created #ranking channel: ${channel.id}`);
  }

  try {
    await channel.permissionOverwrites.set([
      {
        id: guild.roles.everyone,
        allow: ["ViewChannel", "ReadMessageHistory", "UseApplicationCommands"],
        deny: ["SendMessages"],
      },
      {
        id: guild.members.me.id,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ManageMessages",
          "ReadMessageHistory",
          "UseApplicationCommands",
          "ManageChannels",
        ],
      },
    ]);
    console.log(`✅ Permissions set on #${channel.name}`);
  } catch (err) {
    console.warn(`⚠️  Could not set permissions on #${channel.name}:`, err.message);
  }

  return channel;
}

// Cached channel object — set once on startup, reused on every cron tick.
// Re-calling ensureRankingChannel() on every tick caused permission rewrites
// that rate-limited the bot and silently broke the 5-min update loop.
let rankingChannel = null;

// ─── Update Ranking Channel (edit-in-place) ───────────────────────────────────
async function updateRankingChannel() {
  try {
    // Use the cached channel; fall back to re-fetching only if it somehow got lost
    if (!rankingChannel) {
      const guild = client.guilds.cache.first();
      if (!guild) { console.warn("⚠️  updateRankingChannel: no guild in cache"); return; }
      rankingChannel = await ensureRankingChannel(guild);
    }
    const channel = rankingChannel;
    if (!channel) { console.warn("⚠️  updateRankingChannel: could not get channel"); return; }

    const headerEmbed   = buildPointSystemEmbed();
    const top20Embed    = buildTop20Embed();
    const commandsEmbed = buildCommandsEmbed();

    // ── Fast path: edit by cached IDs ────────────────────────────────────────
    if (rankingMsgIds.header && rankingMsgIds.leaderboard && rankingMsgIds.commands) {
      try {
        const [m1, m2, m3] = await Promise.all([
          channel.messages.fetch(rankingMsgIds.header),
          channel.messages.fetch(rankingMsgIds.leaderboard),
          channel.messages.fetch(rankingMsgIds.commands),
        ]);
        await m1.edit({ embeds: [headerEmbed] });
        await m2.edit({ embeds: [top20Embed] });
        await m3.edit({ embeds: [commandsEmbed] });
        console.log(`✅ [${new Date().toISOString()}] Ranking channel updated (edit-in-place).`);
        return;
      } catch (editErr) {
        console.warn("⚠️  Cached IDs stale, rediscovering...", editErr.message);
        rankingMsgIds.header = rankingMsgIds.leaderboard = rankingMsgIds.commands = null;
      }
    }

    // ── Slow path: scan for existing bot messages ─────────────────────────────
    const fetched = await channel.messages.fetch({ limit: 50 });
    const botMsgs = [...fetched.values()]
      .filter((m) => m.author.id === client.user.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp); // oldest first

    if (botMsgs.length >= 3) {
      await botMsgs[0].edit({ embeds: [headerEmbed] });
      await botMsgs[1].edit({ embeds: [top20Embed] });
      await botMsgs[2].edit({ embeds: [commandsEmbed] });

      rankingMsgIds.header      = botMsgs[0].id;
      rankingMsgIds.leaderboard = botMsgs[1].id;
      rankingMsgIds.commands    = botMsgs[2].id;

      // Clean up any stray extra bot messages
      for (let i = 3; i < botMsgs.length; i++) {
        try { await botMsgs[i].delete(); } catch {}
      }
      console.log(`✅ [${new Date().toISOString()}] Ranking channel updated (rediscovered).`);
    } else {
      // Clean slate
      for (const m of botMsgs) {
        try { await m.delete(); } catch {}
      }

      const m1 = await channel.send({ embeds: [headerEmbed] });
      const m2 = await channel.send({ embeds: [top20Embed] });
      const m3 = await channel.send({ embeds: [commandsEmbed] });

      rankingMsgIds.header      = m1.id;
      rankingMsgIds.leaderboard = m2.id;
      rankingMsgIds.commands    = m3.id;

      // Pin each message then immediately delete the "pinned a message"
      // system notification Discord auto-posts — keeps the channel silent.
      for (const m of [m1, m2, m3]) {
        try {
          await m.pin();
          // Give Discord ~400 ms to post the system pin notification, then nuke it
          await new Promise((r) => setTimeout(r, 400));
          const recent = await channel.messages.fetch({ limit: 5 });
          const pinNotice = recent.find(
            (msg) =>
              msg.type === 6 && // MessageType.ChannelPinnedMessage = 6
              msg.author.id === client.user.id &&
              Date.now() - msg.createdTimestamp < 10_000
          );
          if (pinNotice) await pinNotice.delete().catch(() => {});
        } catch {}
      }

      console.log(`✅ [${new Date().toISOString()}] Ranking channel: fresh messages posted & pinned.`);
    }
  } catch (err) {
    // Log but DO NOT re-throw — a throw here would kill the cron tick
    console.error(`❌ [${new Date().toISOString()}] updateRankingChannel error:`, err);
  }
}

// Safe cron wrapper — any error is caught so future ticks always fire
function safeCronUpdate() {
  updateRankingChannel().catch((err) =>
    console.error("❌ safeCronUpdate caught:", err)
  );
}

// ─── Sync existing members into DB on startup ─────────────────────────────────
async function syncAllMembers(guild) {
  try {
    const members = await guild.members.fetch();
    let added = 0;
    for (const [, member] of members) {
      if (member.user.bot) continue;
      const existing = db.getUser(member.user.id, member.user.username);
      if (!existing.synced) {
        db.markSynced(member.user.id);
        added++;
      }
    }
    console.log(`✅ Member sync — ${members.size} total, ${added} newly registered.`);
  } catch (err) {
    console.error("Member sync failed:", err);
  }
}

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity("the leaderboard 👀", { type: ActivityType.Watching });

  await registerCommands();

  const guild = client.guilds.cache.first();
  if (guild) await syncAllMembers(guild);

  await updateRankingChannel();

  // Store the channel reference so cron ticks never re-run ensureRankingChannel
  if (!rankingChannel) {
    const guild2 = client.guilds.cache.first();
    if (guild2) rankingChannel = await ensureRankingChannel(guild2);
  }

  // ── FIX: use safeCronUpdate so any error in one tick never kills the cron ──
  cron.schedule("*/5 * * * *", () => {
    console.log(`⏰ [${new Date().toISOString()}] Cron tick — refreshing ranking channel...`);
    safeCronUpdate();
  });

  // Monthly MVP announcement at midnight on the 1st of each month
  cron.schedule("0 0 1 * *", async () => {
    try {
      const topMonth = db.getMonthlyLeaderboard(1);
      if (!topMonth.length) return;

      const winner    = topMonth[0];
      const mk        = db.currentMonthKey();
      const pts       = db.getMonthPoints(winner, mk);
      const now       = new Date();
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const label     = prevMonth.toLocaleString("default", { month: "long", year: "numeric" });

      const channel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
      if (channel) {
        // Silent mention — no @everyone/@here, just plain text
        await channel.send({
          content: `🎉 **Monthly MVP — ${label}!**\n\nCongrats to **${winner.username}** who earned the most points this month with **${pts.toFixed(1)} pts**! 🏆\nThey get to **suggest our next video idea** — stay tuned! 🎬\n\n_Points carry over — keep grinding for next month!_`,
          // flags: 4096 would suppress embeds but this is a plain message, leave as-is
        });
      }
    } catch (err) {
      console.error("Monthly MVP announcement failed:", err);
    }
    await updateRankingChannel();
  });
});

// ─── Message Create ───────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  // Never award points for messages in the ranking channel itself
  if (
    process.env.RANKING_CHANNEL_ID &&
    message.channelId === process.env.RANKING_CHANNEL_ID
  ) return;

  const userId   = message.author.id;
  const username = message.author.username;

  // Cooldown gate
  const now       = Date.now();
  const lastAward = messageCooldowns.get(userId) || 0;
  if (now - lastAward < config.MESSAGE_COOLDOWN) return;
  messageCooldowns.set(userId, now);

  let points = config.MESSAGE_SENT;
  let reason = "message sent";

  if (message.content.length >= 200) {
    points += config.LONG_MESSAGE_BONUS;
    reason += " + long message";
  }

  if (message.attachments.size > 0) {
    points += config.IMAGE_OR_FILE_SHARE;
    reason += " + file share";
  }

  // Daily first-message bonus (keyed to UTC date so restarts don't re-award)
  const today = new Date().toISOString().slice(0, 10);
  if (dailyFirstMessage.get(userId) !== today) {
    dailyFirstMessage.set(userId, today);
    points += config.FIRST_MESSAGE_OF_DAY;
    reason += " + daily bonus";
  }

  db.incrementStat(userId, username, "messages");
  db.addPoints(userId, username, points, reason);
  console.log(`📝 [POINTS] ${username} +${points} pts — ${reason}`);
});

// ─── Reaction Add ─────────────────────────────────────────────────────────────
client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (!reaction.message.guild) return;

  const now       = Date.now();
  const lastAward = reactionCooldowns.get(user.id) || 0;
  if (now - lastAward < config.REACTION_COOLDOWN) return;
  reactionCooldowns.set(user.id, now);

  db.incrementStat(user.id, user.username, "reactions");
  db.addPoints(user.id, user.username, config.REACTION_ADDED, "reaction added");
  console.log(`👍 [POINTS] ${user.username} +${config.REACTION_ADDED} pts — reaction`);
});

// ─── Voice State Update ───────────────────────────────────────────────────────
client.on("voiceStateUpdate", (oldState, newState) => {
  const userId   = newState.id || oldState.id;
  const username =
    newState.member?.user?.username || oldState.member?.user?.username || "Unknown";

  if (!oldState.channelId && newState.channelId) {
    voiceSessions.set(userId, Date.now());
    console.log(`🎙️  ${username} joined voice`);
  }

  if (oldState.channelId && !newState.channelId) {
    const joinTime = voiceSessions.get(userId);
    if (joinTime) {
      const minutes = Math.floor((Date.now() - joinTime) / 60_000);
      if (minutes >= 1) {
        const earned = minutes * config.VOICE_MINUTE;
        db.incrementStat(userId, username, "voiceMinutes");
        db.addPoints(userId, username, earned, `${minutes} min in voice`);
        console.log(`🎙️  [POINTS] ${username} +${earned} pts — ${minutes} min voice`);
      }
      voiceSessions.delete(userId);
    }
  }
});

// ─── Thread Create ────────────────────────────────────────────────────────────
client.on("threadCreate", async (thread) => {
  if (!thread.ownerId) return;
  try {
    const owner = await client.users.fetch(thread.ownerId);
    if (owner.bot) return;
    db.addPoints(owner.id, owner.username, config.THREAD_CREATED, "created a thread");
    console.log(`🧵 [POINTS] ${owner.username} +${config.THREAD_CREATED} pts — thread`);
  } catch {}
});

// ─── Guild Member Add ─────────────────────────────────────────────────────────
client.on("guildMemberAdd", async (member) => {
  if (member.user.bot) return;
  try {
    db.getUser(member.user.id, member.user.username);
    db.markSynced(member.user.id);
    console.log(`👋 New member registered: ${member.user.username}`);
  } catch (err) {
    console.error("guildMemberAdd registration failed:", err);
  }
});

// ─── Slash Command Handler ────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ── /rank ──────────────────────────────────────────────────────────────────
  if (commandName === "rank") {
    const targetUser = interaction.options.getUser("user");

    // Individual rank card
    if (targetUser) {
      db.getUser(targetUser.id, targetUser.username);
      const embed = buildRankEmbed(targetUser.id);
      if (!embed) {
        return interaction.reply({
          content: "No data found for that user yet.",
        });
      }
      return interaction.reply({ embeds: [embed] });
    }

    // Leaderboard list
    const mode  = interaction.options.getString("mode") || "top";
    const count = interaction.options.getInteger("count") || 10;
    const users = db.getLeaderboard(count, mode);

    if (!users.length) {
      return interaction.reply({
        content: "No users on the leaderboard yet.",
      });
    }

    const medals    = ["🥇", "🥈", "🥉"];
    const allSorted = db.getLeaderboard(9999, "top");

    const rows = users.map((user, i) => {
      const absRank = mode === "last"
        ? allSorted.length - users.length + i + 1
        : i + 1;
      const medal = absRank <= 3 ? medals[absRank - 1] : `**#${absRank}**`;
      const title = getRankTitle(user.points);
      const pts   = user.points % 1 === 0
        ? user.points.toLocaleString()
        : user.points.toFixed(1);
      return `${medal} **${user.username}** — ${pts} pts ${title}`;
    });

    const PAGE = 25;
    const pages = [];
    for (let p = 0; p < rows.length; p += PAGE) {
      pages.push(rows.slice(p, p + PAGE).join("\n"));
    }

    const modeLabel  = mode === "last" ? `Bottom ${count}` : `Top ${count}`;
    const totalUsers = allSorted.length;

    const embeds = pages.map((page, pi) =>
      new EmbedBuilder()
        .setTitle(`${mode === "last" ? "⬇️" : "🏆"} ${modeLabel} Rankings`)
        .setColor(mode === "last" ? 0x95a5a6 : 0xf5a623)
        .setDescription(page)
        .setFooter({
          text: `Page ${pi + 1}/${pages.length} · ${totalUsers} total members · /rank @user for individual card`,
        })
        .setTimestamp()
    );

    return interaction.reply({ embeds: embeds.slice(0, 10) });
  }

  // ── /addpoints ─────────────────────────────────────────────────────────────
  if (commandName === "addpoints") {
    const target = interaction.options.getUser("user");
    const amount = interaction.options.getNumber("amount");
    const reason = interaction.options.getString("reason");

    const updated = db.addPoints(target.id, target.username, amount, `[Admin] ${reason}`);
    db.incrementStat(target.id, target.username, "challenges");

    // Confirmation visible to the channel
    await interaction.reply({
      content: `✅ Added **${amount} pts** to **${target.username}** for: *${reason}*\nNew total: **${updated.points.toFixed(1)} pts**`,
    });
    await updateRankingChannel();
    return;
  }

  // ── /deductpoints ──────────────────────────────────────────────────────────
  if (commandName === "deductpoints") {
    const target = interaction.options.getUser("user");
    const amount = interaction.options.getNumber("amount");
    const reason = interaction.options.getString("reason");

    const updated = db.deductPoints(target.id, target.username, amount, `[Admin] ${reason}`);

    await interaction.reply({
      content: `⚠️ Deducted **${amount} pts** from **${target.username}** for: *${reason}*\nNew total: **${updated.points.toFixed(1)} pts**`,
    });
    await updateRankingChannel();
    return;
  }

  // ── /history ───────────────────────────────────────────────────────────────
  if (commandName === "history") {
    const history = db.getAllHistory(15);
    if (!history.length) {
      return interaction.reply({
        content: "No activity recorded yet.",
      });
    }

    const lines = history.map((h) => {
      const sign = h.amount >= 0 ? "+" : "";
      const time = new Date(h.timestamp).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "short",
      });
      return `\`${time}\`  **${h.username}**  ${sign}${h.amount} pts — *${h.reason}*`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📜  Recent Point Activity")
      .setDescription(lines.join("\n"))
      .setTimestamp()
      .setFooter({ text: "Showing last 15 events" });

    return interaction.reply({ embeds: [embed] });
  }

  // ── /leaderboard ───────────────────────────────────────────────────────────
  if (commandName === "leaderboard") {
    const embed = buildLeaderboardEmbed();
    return interaction.reply({ embeds: [embed] });
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);