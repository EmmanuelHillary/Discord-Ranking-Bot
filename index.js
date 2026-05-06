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
const threadCooldowns   = new Collection(); // userId → last award ms
const voiceSessions     = new Collection(); // userId → session info

// Cached message IDs for the three pinned ranking embeds
const rankingMsgIds = { header: null, leaderboard: null, commands: null };

// ─── Anti-Farm Detection ─────────────────────────────────────────────────────
// In-memory state for fast detection — penalties are persisted via deductPoints.
const recentMessages    = new Map(); // userId → [{ content, ts }]
const recentReactions   = new Map(); // userId → [ts, ts, ...]
const recentVoiceJoins  = new Map(); // userId → [ts, ts, ...]
const lastFarmPenaltyAt = new Map(); // userId → ts of last penalty

function applyFarmPenalty(userId, username, reason) {
  const now  = Date.now();
  const last = lastFarmPenaltyAt.get(userId) || 0;
  if (now - last < config.FARM_PENALTY_COOLDOWN) return false;
  lastFarmPenaltyAt.set(userId, now);
  db.deductPoints(userId, username, config.FARM_PENALTY, `[Anti-farm] ${reason}`);
  console.log(`🚨 [ANTI-FARM] -${config.FARM_PENALTY} pts from ${username} — ${reason}`);
  return true;
}

function detectRepeatedContent(userId, content) {
  const norm = (content || "").trim().toLowerCase();
  if (norm.length < 2) return false; // ignore very short / empty
  const now    = Date.now();
  const list   = (recentMessages.get(userId) || []).filter(
    (e) => now - e.ts < config.FARM_REPEAT_WINDOW
  );
  list.push({ content: norm, ts: now });
  recentMessages.set(userId, list);
  const sameCount = list.filter((e) => e.content === norm).length;
  return sameCount >= config.FARM_REPEAT_THRESHOLD;
}

function detectReactionBurst(userId) {
  const now  = Date.now();
  const list = (recentReactions.get(userId) || []).filter(
    (t) => now - t < config.FARM_REACTION_BURST_WINDOW
  );
  list.push(now);
  recentReactions.set(userId, list);
  return list.length > config.FARM_REACTION_BURST_LIMIT;
}

function detectVoiceRejoinSpam(userId) {
  const now  = Date.now();
  const list = (recentVoiceJoins.get(userId) || []).filter(
    (t) => now - t < config.FARM_VOICE_REJOIN_WINDOW
  );
  list.push(now);
  recentVoiceJoins.set(userId, list);
  return list.length >= config.FARM_VOICE_REJOIN_THRESHOLD;
}

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
    .setName("resetpoints")
    .setDescription("Reset points for a user, or for everyone (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("Target user. Omit to reset every member.")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("confirm")
        .setDescription('Type "CONFIRM" to authorise a server-wide reset')
        .setRequired(false)
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

// ─── Ensure #ranking channel exists & is locked down ─────────────────────────
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
      topic:
        "🏆 Server leaderboard & points system — view-only. Use /rank, /history, /leaderboard.",
    });
    console.log(`✅ Created #ranking channel: ${channel.id}`);
  }

  // Read-only for @everyone: can view & read history, cannot send, react,
  // create threads, or use voice. Bot retains full management rights.
  try {
    await channel.permissionOverwrites.set([
      {
        id: guild.roles.everyone,
        allow: [
          "ViewChannel",
          "ReadMessageHistory",
          "UseApplicationCommands",
        ],
        deny: [
          "SendMessages",
          "AddReactions",
          "CreatePublicThreads",
          "CreatePrivateThreads",
          "SendMessagesInThreads",
          "AttachFiles",
          "EmbedLinks",
        ],
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
          "AddReactions",
          "EmbedLinks",
          "AttachFiles",
        ],
      },
    ]);
    console.log(`✅ Permissions locked down on #${channel.name} (read-only for members)`);
  } catch (err) {
    console.warn(`⚠️  Could not set permissions on #${channel.name}:`, err.message);
  }

  return channel;
}

// Cached channel object — set once on startup, reused on every cron tick.
let rankingChannel = null;

// ─── Update Ranking Channel (edit-in-place) ───────────────────────────────────
async function updateRankingChannel() {
  try {
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

    const fetched = await channel.messages.fetch({ limit: 50 });
    const botMsgs = [...fetched.values()]
      .filter((m) => m.author.id === client.user.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (botMsgs.length >= 3) {
      await botMsgs[0].edit({ embeds: [headerEmbed] });
      await botMsgs[1].edit({ embeds: [top20Embed] });
      await botMsgs[2].edit({ embeds: [commandsEmbed] });

      rankingMsgIds.header      = botMsgs[0].id;
      rankingMsgIds.leaderboard = botMsgs[1].id;
      rankingMsgIds.commands    = botMsgs[2].id;

      for (let i = 3; i < botMsgs.length; i++) {
        try { await botMsgs[i].delete(); } catch {}
      }
      console.log(`✅ [${new Date().toISOString()}] Ranking channel updated (rediscovered).`);
    } else {
      for (const m of botMsgs) {
        try { await m.delete(); } catch {}
      }

      const m1 = await channel.send({ embeds: [headerEmbed] });
      const m2 = await channel.send({ embeds: [top20Embed] });
      const m3 = await channel.send({ embeds: [commandsEmbed] });

      rankingMsgIds.header      = m1.id;
      rankingMsgIds.leaderboard = m2.id;
      rankingMsgIds.commands    = m3.id;

      for (const m of [m1, m2, m3]) {
        try {
          await m.pin();
          await new Promise((r) => setTimeout(r, 400));
          const recent = await channel.messages.fetch({ limit: 5 });
          const pinNotice = recent.find(
            (msg) =>
              msg.type === 6 &&
              msg.author.id === client.user.id &&
              Date.now() - msg.createdTimestamp < 10_000
          );
          if (pinNotice) await pinNotice.delete().catch(() => {});
        } catch {}
      }

      console.log(`✅ [${new Date().toISOString()}] Ranking channel: fresh messages posted & pinned.`);
    }
  } catch (err) {
    console.error(`❌ [${new Date().toISOString()}] updateRankingChannel error:`, err);
  }
}

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

// ─── Voice quality scan ──────────────────────────────────────────────────────
// Every minute, walk active voice sessions and accumulate ineligible time:
//   • selfDeafened minutes don't count
//   • alone-in-channel minutes don't count
// At session end, those minutes are subtracted from gross duration.
function startVoiceQualityScan() {
  setInterval(() => {
    for (const [userId, session] of voiceSessions) {
      try {
        const guild  = client.guilds.cache.first();
        const member = guild?.members.cache.get(userId);
        if (!member?.voice?.channel) continue;

        const humans = member.voice.channel.members.filter((m) => !m.user.bot).size;
        if (humans < 2)            session.aloneMinutes    = (session.aloneMinutes    || 0) + 1;
        if (member.voice.selfDeaf) session.deafenedMinutes = (session.deafenedMinutes || 0) + 1;
      } catch {}
    }
  }, 60_000);
}

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity("the leaderboard 👀", { type: ActivityType.Watching });

  await registerCommands();

  const guild = client.guilds.cache.first();
  if (guild) await syncAllMembers(guild);

  await updateRankingChannel();

  if (!rankingChannel) {
    const guild2 = client.guilds.cache.first();
    if (guild2) rankingChannel = await ensureRankingChannel(guild2);
  }

  startVoiceQualityScan();

  cron.schedule("*/5 * * * *", () => {
    console.log(`⏰ [${new Date().toISOString()}] Cron tick — refreshing ranking channel...`);
    safeCronUpdate();
  });

  // Daily housekeeping: prune old reaction-award entries to keep the DB small
  cron.schedule("0 4 * * *", () => {
    const dropped = db.cleanupReactionAwards(30);
    if (dropped) console.log(`🧹 Pruned ${dropped} old reaction-award entries`);
  });

  // Monthly MVP announcement at midnight on the 1st of each month.
  // FIX: query the *previous* month's bucket, not the current one (which has
  // just rolled over to zero at the moment this cron fires).
  cron.schedule("0 0 1 * *", async () => {
    try {
      const prevMK   = db.previousMonthKey();
      const topPrev  = db.getMonthlyLeaderboard(1, prevMK);

      if (!topPrev.length) {
        console.log("Monthly MVP: no activity in previous month — skipping announcement.");
        await updateRankingChannel();
        return;
      }

      const winner    = topPrev[0];
      const pts       = db.getMonthPoints(winner, prevMK);
      const now       = new Date();
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const label     = prevMonth.toLocaleString("default", { month: "long", year: "numeric" });

      const channel = await client.channels.fetch(process.env.RANKING_CHANNEL_ID);
      if (channel) {
        await channel.send({
          content:
            `🎉 **Monthly MVP — ${label}!**\n\n` +
            `Congrats to **${winner.username}** who earned the most points last month with ` +
            `**${pts.toFixed(1)} pts**! 🏆\n` +
            `They get to **suggest our next video idea** — stay tuned! 🎬\n\n` +
            `_Points carry over — keep grinding for next month!_`,
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

  // Never award (or anti-farm-scan) for messages in the ranking channel itself
  if (
    process.env.RANKING_CHANNEL_ID &&
    message.channelId === process.env.RANKING_CHANNEL_ID
  ) return;

  const userId   = message.author.id;
  const username = message.author.username;

  // ── Anti-farm: repeated identical content
  if (detectRepeatedContent(userId, message.content)) {
    applyFarmPenalty(userId, username, "repeated identical messages");
  }

  // ── Cooldown gate
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

  // Daily first-message bonus — persisted, so a restart doesn't re-award
  const today = new Date().toISOString().slice(0, 10);
  if (db.getDailyFirst(userId) !== today) {
    db.setDailyFirst(userId, today);
    points += config.FIRST_MESSAGE_OF_DAY;
    reason += " + daily bonus";
  }

  db.incrementStat(userId, username, "messages");
  db.addPoints(userId, username, points, reason);
  console.log(`📝 [POINTS] ${username} +${points} pts — ${reason}`);
});

// ─── Reaction Add ─────────────────────────────────────────────────────────────
client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;

    // Resolve partials so we have message author + IDs
    if (reaction.partial)         await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    if (!reaction.message.guild)  return;

    // Don't award for reactions in the ranking channel
    if (
      process.env.RANKING_CHANNEL_ID &&
      reaction.message.channelId === process.env.RANKING_CHANNEL_ID
    ) return;

    const messageId = reaction.message.id;
    const author    = reaction.message.author;

    // ── Loophole: don't award for reacting to the user's own message
    if (author && author.id === user.id) {
      applyFarmPenalty(user.id, user.username, "self-reaction");
      return;
    }

    // ── Loophole: don't award for reactions on bot messages
    if (author && author.bot) return;

    // ── Reaction-once: no re-award for unreact + react
    if (db.hasReactionAward(user.id, messageId)) return;

    // ── Reaction-burst farm detection
    if (detectReactionBurst(user.id)) {
      applyFarmPenalty(user.id, user.username, "reaction burst");
      return; // skip award on flagged burst
    }

    // ── Cooldown gate (still applies to space awards over time)
    const now       = Date.now();
    const lastAward = reactionCooldowns.get(user.id) || 0;
    if (now - lastAward < config.REACTION_COOLDOWN) return;
    reactionCooldowns.set(user.id, now);

    // Record the (user, message) award BEFORE crediting so concurrent
    // re-reactions can't double-award.
    db.recordReactionAward(user.id, messageId);
    db.incrementStat(user.id, user.username, "reactions");
    db.addPoints(user.id, user.username, config.REACTION_ADDED, "reaction added");
    console.log(`👍 [POINTS] ${user.username} +${config.REACTION_ADDED} pts — reaction`);
  } catch (err) {
    console.error("messageReactionAdd error:", err);
  }
});

// ─── Voice State Update ───────────────────────────────────────────────────────
client.on("voiceStateUpdate", (oldState, newState) => {
  const userId   = newState.id || oldState.id;
  const username =
    newState.member?.user?.username || oldState.member?.user?.username || "Unknown";

  // ── Joined voice
  if (!oldState.channelId && newState.channelId) {
    voiceSessions.set(userId, {
      joinTime: Date.now(),
      aloneMinutes: 0,
      deafenedMinutes: 0,
    });
    console.log(`🎙️  ${username} joined voice`);

    // Anti-farm: rapid voice rejoin spam
    if (detectVoiceRejoinSpam(userId)) {
      applyFarmPenalty(userId, username, "voice rejoin spam");
    }
    return;
  }

  // ── Left voice
  if (oldState.channelId && !newState.channelId) {
    const session = voiceSessions.get(userId);
    if (!session) return;

    const grossMinutes = Math.floor((Date.now() - session.joinTime) / 60_000);
    const ineligible   = (session.aloneMinutes || 0) + (session.deafenedMinutes || 0);
    const effective    = Math.max(0, grossMinutes - ineligible);

    if (effective >= config.VOICE_MIN_MINUTES) {
      const earned = effective * config.VOICE_MINUTE;
      db.incrementStat(userId, username, "voiceMinutes");
      db.addPoints(userId, username, earned, `${effective} min in voice`);
      console.log(
        `🎙️  [POINTS] ${username} +${earned} pts — ${effective} min ` +
        `(gross ${grossMinutes}, ineligible ${ineligible})`
      );
    } else if (grossMinutes >= config.VOICE_MIN_MINUTES) {
      console.log(
        `🚫 [VOICE] ${username} — ${grossMinutes} min logged but ${ineligible} ineligible ` +
        `(alone/deafened); no points`
      );
    }

    voiceSessions.delete(userId);
  }
});

// ─── Thread Create ────────────────────────────────────────────────────────────
client.on("threadCreate", async (thread) => {
  if (!thread.ownerId) return;
  try {
    const owner = await client.users.fetch(thread.ownerId);
    if (owner.bot) return;

    // Anti-farm: cooldown per-user so thread spam can't farm
    const now       = Date.now();
    const lastAward = threadCooldowns.get(owner.id) || 0;
    if (now - lastAward < config.THREAD_COOLDOWN) return;
    threadCooldowns.set(owner.id, now);

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

    if (targetUser) {
      db.getUser(targetUser.id, targetUser.username);
      const embed = buildRankEmbed(targetUser.id);
      if (!embed) {
        return interaction.reply({ content: "No data found for that user yet." });
      }
      return interaction.reply({ embeds: [embed] });
    }

    const mode  = interaction.options.getString("mode") || "top";
    const count = interaction.options.getInteger("count") || 10;
    const users = db.getLeaderboard(count, mode);

    if (!users.length) {
      return interaction.reply({ content: "No users on the leaderboard yet." });
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
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "🚫 Admin only.", ephemeral: true });
    }
    const target = interaction.options.getUser("user");
    const amount = interaction.options.getNumber("amount");
    const reason = interaction.options.getString("reason");

    const updated = db.addPoints(target.id, target.username, amount, `[Admin] ${reason}`);
    db.incrementStat(target.id, target.username, "challenges");

    await interaction.reply({
      content: `✅ Added **${amount} pts** to **${target.username}** for: *${reason}*\nNew total: **${updated.points.toFixed(1)} pts**`,
    });
    await updateRankingChannel();
    return;
  }

  // ── /deductpoints ──────────────────────────────────────────────────────────
  if (commandName === "deductpoints") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "🚫 Admin only.", ephemeral: true });
    }
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

  // ── /resetpoints ───────────────────────────────────────────────────────────
  if (commandName === "resetpoints") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: "🚫 This command requires the **Administrator** permission.",
        ephemeral: true,
      });
    }

    const target  = interaction.options.getUser("user");
    const confirm = (interaction.options.getString("confirm") || "").trim();

    if (target) {
      const result = db.resetPoints(target.id);
      if (!result) {
        return interaction.reply({
          content: `No points record found for **${target.username}**.`,
          ephemeral: true,
        });
      }
      await interaction.reply({
        content: `🧹 Points reset for **${target.username}**. They are now back to **0 pts**.`,
      });
      await updateRankingChannel();
      return;
    }

    // Server-wide reset requires explicit confirmation
    if (confirm !== "CONFIRM") {
      return interaction.reply({
        content:
          "⚠️ **Server-wide reset.** This wipes everyone's points and monthly buckets.\n" +
          'Re-run with `confirm: CONFIRM` to proceed.',
        ephemeral: true,
      });
    }
    const count = db.resetAllPoints();
    await interaction.reply({
      content: `🧹 Reset points for **${count}** members. Monthly buckets cleared.`,
    });
    await updateRankingChannel();
    return;
  }

  // ── /history ───────────────────────────────────────────────────────────────
  if (commandName === "history") {
    const history = db.getAllHistory(15);
    if (!history.length) {
      return interaction.reply({ content: "No activity recorded yet." });
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
