module.exports = {
  // ─── Manual Points ───────────────────────────────────────────────
  COMMUNITY_CHALLENGE_SOLVE: 50,   // Correctly solving a community challenge

  // ─── Auto-tracked Points ─────────────────────────────────────────
  MESSAGE_SENT: 0.5,               // Sending any message
  REACTION_ADDED: 0.05,            // Adding a reaction (one-time per message)
  VOICE_MINUTE: 0.5,               // Every minute spent in a voice channel
  HELPFUL_ANSWER: 2,               // Being thanked / marked helpful (manual)
  INVITE_MEMBER: 2,                // Successfully inviting a new member
  FIRST_MESSAGE_OF_DAY: 2,         // First message each day (daily bonus)
  IMAGE_OR_FILE_SHARE: 0.5,        // Sharing an image or file in chat
  THREAD_CREATED: 1,               // Creating a new thread
  LONG_MESSAGE_BONUS: 1,           // Message over 200 chars (quality contribution)

  // ─── Leaderboard settings ────────────────────────────────────────
  TOP_N: 10,

  // ─── Cooldowns (ms) ──────────────────────────────────────────────
  MESSAGE_COOLDOWN:  10_000,       // 10s between message point awards
  REACTION_COOLDOWN: 15_000,       // 15s between reaction point awards
  THREAD_COOLDOWN:   5 * 60_000,   // 5 min between thread point awards
  VOICE_MIN_MINUTES: 5,            // Minimum effective minutes to earn voice pts

  // ─── Anti-Farm Detection ─────────────────────────────────────────
  FARM_PENALTY:                10,         // Points deducted per detection
  FARM_PENALTY_COOLDOWN:       60_000,     // Min ms between penalties per user
  FARM_REPEAT_WINDOW:          10 * 60_000, // 10 min window for repeated content
  FARM_REPEAT_THRESHOLD:       3,          // Identical messages → farm
  FARM_VOICE_REJOIN_WINDOW:    5 * 60_000, // 5 min window for voice rejoins
  FARM_VOICE_REJOIN_THRESHOLD: 4,          // Rejoins within window → farm
  FARM_REACTION_BURST_WINDOW:  60_000,     // 60s window for reaction bursts
  FARM_REACTION_BURST_LIMIT:   8,          // Reactions/min before flagged

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
