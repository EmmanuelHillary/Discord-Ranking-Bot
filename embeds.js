const { EmbedBuilder } = require("discord.js");
const db = require("./database");
const { RANK_TITLES } = require("./config");

// ─── Palette ──────────────────────────────────────────────────────────────────
const COLORS = {
  gold:   0xf5c518,
  purple: 0x5865f2,
  dark:   0x2b2d31,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRankTitle(points) {
  let title = RANK_TITLES[0].label;
  for (const tier of RANK_TITLES) {
    if (points >= tier.min) title = tier.label;
  }
  return title;
}

function formatPoints(pts) {
  if (pts === 0) return "0";
  return pts % 1 === 0 ? pts.toLocaleString() : pts.toFixed(1);
}

function getProgressBar(current, nextMin, length = 14) {
  if (!nextMin) return "▰".repeat(length) + "  ✦ MAX RANK";
  const pct    = Math.min(current / nextMin, 1);
  const filled = Math.round(pct * length);
  const bar    = "▰".repeat(filled) + "▱".repeat(length - filled);
  return `${bar}  ${Math.round(pct * 100)}%`;
}

function getCurrentMonthLabel() {
  return new Date().toLocaleString("default", { month: "long", year: "numeric" });
}

// Pad a string to exact length (for table alignment)
function pad(str, len, align = "left") {
  const s = String(str);
  if (align === "right") return s.padStart(len);
  return s.padEnd(len);
}

// ─── Embed 1 — Point System (your original, untouched) ───────────────────────

function buildPointSystemEmbed() {
  const monthly = db.getMonthlyLeaderboard(1);
  const mk      = db.currentMonthKey();
  const month   = getCurrentMonthLabel();

  let mvpBlock = "";
  if (monthly[0]) {
    const mPts = db.getMonthPoints(monthly[0], mk);
    if (mPts > 0) {
      mvpBlock = [
        "```fix",
        `  ★  ${month.toUpperCase()} MVP`,
        `  ▸  ${monthly[0].username}`,
        `  ⭐  ${formatPoints(mPts)} pts earned this month`,
        `  🎬  Earns the right to suggest our next video idea`,
        "```",
        "",
      ].join("\n");
    }
  }

  const desc = [
    mvpBlock,
    "> **Earn points by being an active, engaged member.**",
    "> Every message, reaction, and voice minute counts.",
    "> The more you contribute — the higher you climb.",
    "",

    "╔══════════════════════════════════════╗",
    "║          **HOW TO EARN POINTS**          ║",
    "╚══════════════════════════════════════╝",
    "",

    "**✦  CHALLENGE & CONTRIBUTION**",
    "```yaml",
    "  ✅  Solve a Community Challenge   →   50 pts",
    "  🤝  Invite a new member           →    2 pts",
    "  ✨  Helpful answer (admin given)  →    2 pts",
    "  🧵  Start a thread                →    1 pt",
    "```",

    "**✦  DAILY ACTIVITY**",
    "```yaml",
    "  🌅  First message of the day      →   +2 pts",
    "  📝  Long message  (200+ chars)    →   +1 pt",
    "  📎  Share a file or image          →  +0.5 pt",
    "  🎙️  Voice chat                    →  +0.5 pt / min",
    "```",

    "**✦  GENERAL ENGAGEMENT**",
    "```yaml",
    "  💬  Send a message     →  0.5 pts  ⏱ 10s cooldown",
    "  👍  Add a reaction     →  0.5 pts  ⏱  5s cooldown",
    "```",
    "",

    "╔══════════════════════════════════════╗",
    "║             **RANK  TIERS**              ║",
    "╚══════════════════════════════════════╝",
    "",

    "```ansi",
    "  \u001b[2;37m😝  Newcomer       \u001b[0m ·  \u001b[2;37m      0 pts\u001b[0m",
    "  \u001b[2;32m🌱  Rising Star    \u001b[0m ·  \u001b[2;32m     50 pts\u001b[0m",
    "  \u001b[2;36m⚡  Active Member  \u001b[0m ·  \u001b[2;36m    150 pts\u001b[0m",
    "  \u001b[2;31m🔥  Engaged        \u001b[0m ·  \u001b[2;31m    350 pts\u001b[0m",
    "  \u001b[1;34m💎  Community Gem  \u001b[0m ·  \u001b[1;34m    700 pts\u001b[0m",
    "  \u001b[1;33m🏆  Elite          \u001b[0m ·  \u001b[1;33m  1,200 pts\u001b[0m",
    "  \u001b[1;35m👑  Legend         \u001b[0m ·  \u001b[1;35m  2,500 pts\u001b[0m",
    "```",
  ].filter((l) => l !== null).join("\n");

  return new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle("✦  WELCOME TO THE RANKINGS  ✦")
    .setDescription(desc)
    .setFooter({
      text: `${month}  ·  Points accumulate forever — they never reset  ·  Refreshes every 5 min`,
    });
}

// ─── Embed 2 — Top 20 Leaderboard (table layout) ─────────────────────────────

function buildTop20Embed() {
  const top   = db.getLeaderboard(20, "top");
  const mk    = db.currentMonthKey();
  const total = db.getLeaderboard(9999, "top").length;

  if (!top.length) {
    return new EmbedBuilder()
      .setColor(COLORS.dark)
      .setTitle("📊  HALL OF FAME  —  TOP 20")
      .setDescription(
        "```\n  No activity recorded yet.\n  Start chatting to appear on the board!\n```"
      )
      .setTimestamp()
      .setFooter({ text: "🔄 Auto-refreshes every 5 minutes" });
  }

  const posLabel = (i) => {
    if (i === 0) return " 🥇 ";
    if (i === 1) return " 🥈 ";
    if (i === 2) return " 🥉 ";
    return pad(`#${i + 1}`, 4, "right");
  };

  // Table header
  // Columns: POS | USERNAME (18) | POINTS (8) | THIS MONTH (10) | TIER
  const COL_NAME  = 18;
  const COL_PTS   = 8;
  const COL_MO    = 11;
  const COL_TIER  = 7;

  const header =
    pad("POS",  4)  + "  " +
    pad("USERNAME", COL_NAME) + "  " +
    pad("POINTS",   COL_PTS)  + "  " +
    pad("THIS MONTH", COL_MO) + "  " +
    "TIER";

  const divider = "─".repeat(4) + "──" +
    "─".repeat(COL_NAME) + "──" +
    "─".repeat(COL_PTS)  + "──" +
    "─".repeat(COL_MO)   + "──" +
    "─".repeat(COL_TIER);

  const rows = top.map((u, i) => {
    const mPts    = db.getMonthPoints(u, mk);
    const moLabel = mPts > 0 ? `+${formatPoints(mPts)}` : "—";
    const name    = u.username.length > COL_NAME
      ? u.username.slice(0, COL_NAME - 1) + "…"
      : u.username;

    return (
      pad(posLabel(i), 4) + "  " +
      pad(name,        COL_NAME) + "  " +
      pad(formatPoints(u.points), COL_PTS) + "  " +
      pad(moLabel,     COL_MO)   + "  " +
      getRankTitle(u.points)
    );
  });

  const table = [
    "```",
    header,
    divider,
    ...rows,
    divider,
    `  ${total} members ranked  ·  /rank top 500 for full list`,
    "```",
  ].join("\n");

  return new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle("📊  HALL OF FAME  —  TOP 20")
    .setDescription(table)
    .setTimestamp()
    .setFooter({ text: "🔄 Auto-refreshes every 5 min  ·  /rank @user for your personal card" });
}

// ─── Embed 3 — Commands Guide (table layout) ─────────────────────────────────

function buildCommandsEmbed() {
  // Everyone table
  const everyoneRows = [
    ["/rank @user",      "Show a user's personal stats"],
    ["/rank",            "Top 10 leaderboard (default)"],
    ["/rank top 50",     "Top 50 players"],
    ["/rank last 50",    "Bottom 50 players"],
    ["/rank top 500",    "Top 500 — maximum depth"],
    ["/history",         "Recent point activity on the server"],
    ["/leaderboard",     "Show the full leaderboard embed"],
  ];

  const adminRows = [
    ["/addpoints @user <pts> <reason>",   "Award points manually"],
    ["/deductpoints @user <pts> <reason>","Remove points  (floor: 0)"],
  ];

  const COL_CMD  = 32;
  const COL_DESC = 22;

  const divider = "─".repeat(COL_CMD) + "──" + "─".repeat(COL_DESC);

  const formatRow = ([cmd, desc]) =>
    pad(cmd, COL_CMD) + "  " + desc;

  const formatRow2 = ([cmd, desc]) =>
    pad(cmd, COL_CMD - 14) + "  " + desc;

  const everyoneTable = [
    "```yaml",
    pad("COMMAND", COL_CMD) + "  " + "DESCRIPTION",
    divider,
    ...everyoneRows.map(formatRow2),
    "```",
  ].join("\n");

  const adminTable = [
    "```yaml",
    pad("COMMAND", COL_CMD) + "  " + "DESCRIPTION",
    divider,
    ...adminRows.map(formatRow),
    "```",
  ].join("\n");

  const notes = [
    "```fix",
    "  📌  ADMIN NOTES",
    "  • Auto-tracked: messages, reactions, voice, files,",
    "    threads, daily bonuses, and long messages",
    "  • Monthly MVP is announced on the 1st of each month",
    "  • Points never reset — all activity is logged via /history",
    "  • Use /addpoints to credit solved community challenges",
    "```",
  ].join("\n");

  return new EmbedBuilder()
    .setColor(COLORS.purple)
    .setTitle("🔎  BOT COMMANDS  —  HOW TO USE")
    .setDescription(
      "**Available to Everyone**\n" + everyoneTable +
      "\n\n**Admin Only** *(requires Manage Server permission)*\n" + adminTable +
      "\n\n" + notes
    )
    .setFooter({
      text: "This channel is read-only for members  ·  Chat in any other channel to earn points",
    });
}

// ─── Individual Rank Card (/rank @user) ───────────────────────────────────────

function buildRankEmbed(userId) {
  const { rank, user, total, monthlyPoints } = db.getUserRank(userId);
  if (!user) return null;

  const title     = getRankTitle(user.points);
  const nextTier  = RANK_TITLES.find((t) => t.min > user.points);
  const ptsToNext = nextTier ? nextTier.min - user.points : null;
  const bar       = getProgressBar(user.points, nextTier?.min);

  const top3   = db.getLeaderboard(3, "top");
  const isTop3 = top3.some((u) => u.id === userId);
  const color  = isTop3 ? COLORS.gold : COLORS.purple;

  let rankLabel = `#${rank}`;
  if (rank === 1) rankLabel = "🥇 #1";
  else if (rank === 2) rankLabel = "🥈 #2";
  else if (rank === 3) rankLabel = "🥉 #3";

  // Stat table
  const statTable = [
    "```",
    "  STAT            VALUE",
    "  ─────────────────────────",
    `  Server Rank     ${rankLabel} of ${total}`,
    `  Total Points    ${formatPoints(user.points)}`,
    `  This Month      ${formatPoints(monthlyPoints)} pts`,
    `  Messages        ${user.stats.messages}`,
    `  Challenges      ${user.stats.challenges}`,
    `  Reactions       ${user.stats.reactions}`,
    `  Voice Mins      ${user.stats.voiceMinutes}`,
    "```",
  ].join("\n");

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${title}  ·  ${user.username}`)
    .setDescription(
      statTable +
      "\n**Progress to next tier**\n" +
      `\`${bar}\`\n` +
      (ptsToNext
        ? `*${formatPoints(ptsToNext)} pts needed to reach **${nextTier.label}***`
        : "*👑 You have reached the maximum rank tier!*")
    )
    .setTimestamp()
    .setFooter({ text: "Use /rank top 500 to browse the full leaderboard" });
}

// ─── Legacy alias ─────────────────────────────────────────────────────────────

function buildLeaderboardEmbed() {
  return buildTop20Embed();
}

module.exports = {
  getRankTitle,
  formatPoints,
  buildRankEmbed,
  buildLeaderboardEmbed,
  buildPointSystemEmbed,
  buildTop20Embed,
  buildCommandsEmbed,
};