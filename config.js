module.exports = {
  // ─── Manual Points ───────────────────────────────────────────────
  COMMUNITY_CHALLENGE_SOLVE: 50,   // Correctly solving a community challenge

  // ─── Auto-tracked Points ─────────────────────────────────────────
  MESSAGE_SENT: 0.5,               // Sending any message
  REACTION_ADDED: 0.5,             // Adding a reaction to a message
  VOICE_MINUTE: 0.5,                 // Every minute spent in a voice channel
  HELPFUL_ANSWER: 2,               // Being thanked / marked helpful (manual or via command)
  INVITE_MEMBER: 2,               // Successfully inviting a new member
  FIRST_MESSAGE_OF_DAY: 2,         // First message each day (daily bonus)
  IMAGE_OR_FILE_SHARE: 0.5,          // Sharing an image or file in chat
  THREAD_CREATED: 1,               // Creating a new thread
  LONG_MESSAGE_BONUS: 1,           // Message over 200 chars (quality contribution)

  // ─── Leaderboard settings ────────────────────────────────────────
  TOP_N: 10,

  // ─── Cooldowns (ms) ──────────────────────────────────────────────
  MESSAGE_COOLDOWN: 10_000,        // 10s between message point awards (anti-spam)
  REACTION_COOLDOWN: 5_000,        // 5s between reaction point awards

  // ─── Rank Titles ─────────────────────────────────────────────────
  RANK_TITLES: [
    { min: 0,    label: "😝 Newcomer" },
    { min: 50,   label: "🌱 Rising Star" },
    { min: 150,  label: "⚡ Active Member" },
    { min: 350,  label: "🔥 Engaged" },
    { min: 700,  label: "💎 Community Gem" },
    { min: 1200, label: "🏆 Elite" },
    { min: 2500, label: "👑 Legend" },
  ],
};