// ─────────────────────────────────────────────────────────────────────────────
// SQLite-backed persistence layer.
//
// Public API is identical to the previous JSON implementation, so index.js and
// embeds.js do not change. Every mutating function is wrapped in a transaction
// so concurrent Discord events can never tear an update.
//
// Schema:
//   users(id, username, points, synced, <stat columns>)
//   monthly_buckets(user_id, month_key, points)        — composite PK
//   history(id AUTOINCREMENT, user_id, ..., timestamp) — append-only audit log
//   reaction_awards(user_id, message_id, awarded_at)   — reaction-once dedup
//   daily_first(user_id, date)                         — daily bonus tracker
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH  = path.join(DATA_DIR, "points.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const sql = new Database(DB_PATH);

// WAL: concurrent readers don't block the writer; survives crashes safely.
// synchronous=NORMAL is the recommended balance for WAL (fast + durable).
sql.pragma("journal_mode = WAL");
sql.pragma("synchronous = NORMAL");
sql.pragma("foreign_keys = ON");

// ─── Schema ──────────────────────────────────────────────────────────────────
sql.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    username        TEXT NOT NULL,
    points          REAL NOT NULL DEFAULT 0,
    synced          INTEGER NOT NULL DEFAULT 0,
    challenges      INTEGER NOT NULL DEFAULT 0,
    messages        INTEGER NOT NULL DEFAULT 0,
    reactions       INTEGER NOT NULL DEFAULT 0,
    voiceMinutes    INTEGER NOT NULL DEFAULT 0,
    helpfulAnswers  INTEGER NOT NULL DEFAULT 0,
    invites         INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_users_points ON users(points DESC);

  CREATE TABLE IF NOT EXISTS monthly_buckets (
    user_id   TEXT NOT NULL,
    month_key TEXT NOT NULL,
    points    REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_monthly_month_pts ON monthly_buckets(month_key, points DESC);

  CREATE TABLE IF NOT EXISTS history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   TEXT NOT NULL,
    username  TEXT NOT NULL,
    amount    REAL NOT NULL,
    reason    TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_id ON history(id DESC);

  CREATE TABLE IF NOT EXISTS reaction_awards (
    user_id    TEXT NOT NULL,
    message_id TEXT NOT NULL,
    awarded_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_reaction_awards_at ON reaction_awards(awarded_at);

  CREATE TABLE IF NOT EXISTS daily_first (
    user_id TEXT PRIMARY KEY,
    date    TEXT NOT NULL
  );
`);

// ─── One-shot migration from legacy JSON ─────────────────────────────────────
// Runs once: if a points.json exists and the SQLite users table is empty, copy
// every record across in a single transaction, then rename the JSON file so we
// never re-import. The original is preserved as `.migrated` for rollback.
function migrateFromJsonIfNeeded() {
  const jsonPath    = path.join(DATA_DIR, "points.json");
  const archivePath = jsonPath + ".migrated";
  if (!fs.existsSync(jsonPath)) return;

  const userCount = sql.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (userCount > 0) {
    // SQLite already populated — assume migration done; just archive the JSON
    try { fs.renameSync(jsonPath, archivePath); } catch {}
    return;
  }

  console.log("📦 Migrating data from points.json → points.db ...");
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

  const insertUser = sql.prepare(`
    INSERT OR REPLACE INTO users
      (id, username, points, synced,
       challenges, messages, reactions, voiceMinutes, helpfulAnswers, invites)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBucket  = sql.prepare(
    "INSERT OR REPLACE INTO monthly_buckets (user_id, month_key, points) VALUES (?, ?, ?)"
  );
  const insertHistory = sql.prepare(
    "INSERT INTO history (user_id, username, amount, reason, timestamp) VALUES (?, ?, ?, ?, ?)"
  );
  const insertRA      = sql.prepare(
    "INSERT OR REPLACE INTO reaction_awards (user_id, message_id, awarded_at) VALUES (?, ?, ?)"
  );
  const insertDF      = sql.prepare(
    "INSERT OR REPLACE INTO daily_first (user_id, date) VALUES (?, ?)"
  );

  const stats = { users: 0, buckets: 0, history: 0, ra: 0, df: 0 };
  const tx = sql.transaction(() => {
    for (const u of Object.values(data.users || {})) {
      const s = u.stats || {};
      insertUser.run(
        u.id, u.username || "", u.points || 0, u.synced ? 1 : 0,
        s.challenges || 0, s.messages || 0, s.reactions || 0,
        s.voiceMinutes || 0, s.helpfulAnswers || 0, s.invites || 0
      );
      stats.users++;
      for (const [mk, pts] of Object.entries(u.monthlyBuckets || {})) {
        insertBucket.run(u.id, mk, pts || 0);
        stats.buckets++;
      }
    }
    for (const h of (data.history || [])) {
      insertHistory.run(h.userId, h.username, h.amount, h.reason, h.timestamp);
      stats.history++;
    }
    for (const [key, ts] of Object.entries(data.reactionAwards || {})) {
      const idx = key.indexOf(":");
      if (idx === -1) continue;
      insertRA.run(key.slice(0, idx), key.slice(idx + 1), Number(ts) || Date.now());
      stats.ra++;
    }
    for (const [userId, date] of Object.entries(data.dailyFirst || {})) {
      insertDF.run(userId, date);
      stats.df++;
    }
  });
  tx();

  fs.renameSync(jsonPath, archivePath);
  console.log(
    `📦 Migration complete: ${stats.users} users · ${stats.buckets} monthly buckets · ` +
    `${stats.history} history · ${stats.ra} reaction-awards · ${stats.df} daily-first. ` +
    `Original JSON preserved at ${path.basename(archivePath)}.`
  );
}
migrateFromJsonIfNeeded();

// ─── Prepared statements (created once, reused forever) ──────────────────────
const stmt = {
  ensureUser: sql.prepare(`
    INSERT INTO users (id, username) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET username = excluded.username
  `),
  getUser:     sql.prepare("SELECT * FROM users WHERE id = ?"),
  setSynced:   sql.prepare("UPDATE users SET synced = 1 WHERE id = ?"),
  addPoints:   sql.prepare("UPDATE users SET points = points + ? WHERE id = ?"),
  setPoints:   sql.prepare("UPDATE users SET points = ? WHERE id = ?"),
  clampDeduct: sql.prepare("UPDATE users SET points = MAX(0, points - ?) WHERE id = ?"),

  upsertBucket: sql.prepare(`
    INSERT INTO monthly_buckets (user_id, month_key, points) VALUES (?, ?, ?)
    ON CONFLICT(user_id, month_key) DO UPDATE SET points = points + excluded.points
  `),
  clampBucket: sql.prepare(`
    INSERT INTO monthly_buckets (user_id, month_key, points) VALUES (?, ?, 0)
    ON CONFLICT(user_id, month_key) DO UPDATE SET points = MAX(0, points - ?)
  `),
  resetBucketsForUser: sql.prepare("DELETE FROM monthly_buckets WHERE user_id = ?"),
  resetAllBuckets:     sql.prepare("DELETE FROM monthly_buckets"),
  getBucket: sql.prepare("SELECT points FROM monthly_buckets WHERE user_id = ? AND month_key = ?"),

  insertHistory: sql.prepare(
    "INSERT INTO history (user_id, username, amount, reason, timestamp) VALUES (?, ?, ?, ?, ?)"
  ),
  trimHistory: sql.prepare(
    "DELETE FROM history WHERE id <= (SELECT MAX(id) FROM history) - 1000"
  ),
  recentHistory: sql.prepare("SELECT * FROM history ORDER BY id DESC LIMIT ?"),

  topUsers:    sql.prepare("SELECT * FROM users ORDER BY points DESC LIMIT ?"),
  bottomUsers: sql.prepare("SELECT * FROM users ORDER BY points ASC LIMIT ?"),
  countUsers:  sql.prepare("SELECT COUNT(*) AS c FROM users"),
  rankAbove:   sql.prepare("SELECT COUNT(*) AS c FROM users WHERE points > ?"),

  monthlyTop: sql.prepare(`
    SELECT u.*, b.points AS month_points
    FROM monthly_buckets b
    JOIN users u ON u.id = b.user_id
    WHERE b.month_key = ? AND b.points > 0
    ORDER BY b.points DESC LIMIT ?
  `),

  hasReactionAward:    sql.prepare("SELECT 1 FROM reaction_awards WHERE user_id = ? AND message_id = ?"),
  recordReactionAward: sql.prepare(`
    INSERT OR REPLACE INTO reaction_awards (user_id, message_id, awarded_at) VALUES (?, ?, ?)
  `),
  cleanupReactionAwards: sql.prepare("DELETE FROM reaction_awards WHERE awarded_at < ?"),

  getDailyFirst: sql.prepare("SELECT date FROM daily_first WHERE user_id = ?"),
  setDailyFirst: sql.prepare(`
    INSERT INTO daily_first (user_id, date) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET date = excluded.date
  `),

  // Per-stat increments. Column names are whitelisted by the dispatcher below.
  incChallenges:     sql.prepare("UPDATE users SET challenges     = challenges     + 1 WHERE id = ?"),
  incMessages:       sql.prepare("UPDATE users SET messages       = messages       + 1 WHERE id = ?"),
  incReactions:      sql.prepare("UPDATE users SET reactions      = reactions      + 1 WHERE id = ?"),
  incVoiceMinutes:   sql.prepare("UPDATE users SET voiceMinutes   = voiceMinutes   + 1 WHERE id = ?"),
  incHelpfulAnswers: sql.prepare("UPDATE users SET helpfulAnswers = helpfulAnswers + 1 WHERE id = ?"),
  incInvites:        sql.prepare("UPDATE users SET invites        = invites        + 1 WHERE id = ?"),
};

const STAT_INCREMENTERS = {
  challenges:     stmt.incChallenges,
  messages:       stmt.incMessages,
  reactions:      stmt.incReactions,
  voiceMinutes:   stmt.incVoiceMinutes,
  helpfulAnswers: stmt.incHelpfulAnswers,
  invites:        stmt.incInvites,
};

// ─── Hydration helper ────────────────────────────────────────────────────────
// Converts a flat row into the same object shape callers used to receive from
// the JSON layer (so embeds.js doesn't change).
function hydrate(row) {
  if (!row) return null;
  return {
    id:       row.id,
    username: row.username,
    points:   row.points,
    synced:   !!row.synced,
    stats: {
      challenges:     row.challenges,
      messages:       row.messages,
      reactions:      row.reactions,
      voiceMinutes:   row.voiceMinutes,
      helpfulAnswers: row.helpfulAnswers,
      invites:        row.invites,
    },
  };
}

// ─── Date helpers ────────────────────────────────────────────────────────────
function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function previousMonthKey() {
  const now  = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

function getUser(userId, username) {
  stmt.ensureUser.run(userId, username || "");
  return hydrate(stmt.getUser.get(userId));
}

const addPointsTx = sql.transaction((userId, username, amount, reason) => {
  stmt.ensureUser.run(userId, username || "");
  stmt.addPoints.run(amount, userId);
  stmt.upsertBucket.run(userId, currentMonthKey(), amount);
  stmt.insertHistory.run(userId, username, amount, reason, new Date().toISOString());
  stmt.trimHistory.run();
});

function addPoints(userId, username, amount, reason) {
  addPointsTx(userId, username, amount, reason);
  return hydrate(stmt.getUser.get(userId));
}

const deductPointsTx = sql.transaction((userId, username, amount, reason) => {
  stmt.ensureUser.run(userId, username || "");
  stmt.clampDeduct.run(amount, userId);
  stmt.clampBucket.run(userId, currentMonthKey(), amount);
  stmt.insertHistory.run(userId, username, -amount, reason, new Date().toISOString());
  stmt.trimHistory.run();
});

function deductPoints(userId, username, amount, reason) {
  deductPointsTx(userId, username, amount, reason);
  return hydrate(stmt.getUser.get(userId));
}

function incrementStat(userId, username, stat) {
  const inc = STAT_INCREMENTERS[stat];
  if (!inc) return; // unknown stat name → no-op (parity with old behavior)
  stmt.ensureUser.run(userId, username || "");
  inc.run(userId);
}

function getMonthPoints(user, monthKey) {
  if (!user || !user.id) return 0;
  const key = monthKey || currentMonthKey();
  const row = stmt.getBucket.get(user.id, key);
  return row ? row.points : 0;
}

function getLeaderboard(limit = 10, order = "top") {
  const rows = order === "last"
    ? stmt.bottomUsers.all(limit)
    : stmt.topUsers.all(limit);
  return rows.map(hydrate);
}

function getMonthlyLeaderboard(limit = 10, monthKey = null) {
  const key  = monthKey || currentMonthKey();
  const rows = stmt.monthlyTop.all(key, limit);
  return rows.map(hydrate);
}

function getUserRank(userId) {
  const row = stmt.getUser.get(userId);
  if (!row) {
    const total = stmt.countUsers.get().c;
    return { rank: null, user: null, total, monthlyPoints: 0 };
  }
  const total        = stmt.countUsers.get().c;
  const above        = stmt.rankAbove.get(row.points).c;
  const monthlyPoints = getMonthPoints(row, currentMonthKey());
  return { rank: above + 1, user: hydrate(row), total, monthlyPoints };
}

function markSynced(userId) {
  stmt.setSynced.run(userId);
}

function getAllHistory(limit = 20) {
  const rows = stmt.recentHistory.all(limit);
  // Map back to the JSON shape (userId, username, amount, reason, timestamp)
  return rows.map((r) => ({
    userId:    r.user_id,
    username:  r.username,
    amount:    r.amount,
    reason:    r.reason,
    timestamp: r.timestamp,
  }));
}

// ─── Reaction-once tracking ──────────────────────────────────────────────────
function hasReactionAward(userId, messageId) {
  return Boolean(stmt.hasReactionAward.get(userId, messageId));
}

function recordReactionAward(userId, messageId) {
  stmt.recordReactionAward.run(userId, messageId, Date.now());
}

function cleanupReactionAwards(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return stmt.cleanupReactionAwards.run(cutoff).changes;
}

// ─── Daily-first-message persistence ─────────────────────────────────────────
function getDailyFirst(userId) {
  const row = stmt.getDailyFirst.get(userId);
  return row ? row.date : null;
}

function setDailyFirst(userId, dateStr) {
  stmt.setDailyFirst.run(userId, dateStr);
}

// ─── Reset (admin-only) ──────────────────────────────────────────────────────
const resetUserTx = sql.transaction((userId) => {
  const row = stmt.getUser.get(userId);
  if (!row) return null;
  stmt.setPoints.run(0, userId);
  stmt.resetBucketsForUser.run(userId);
  stmt.insertHistory.run(
    userId, row.username, 0, "[Admin] points reset", new Date().toISOString()
  );
  stmt.trimHistory.run();
  return row;
});

function resetPoints(userId) {
  const row = resetUserTx(userId);
  if (!row) return null;
  return hydrate(stmt.getUser.get(userId));
}

const resetAllTx = sql.transaction(() => {
  const count = stmt.countUsers.get().c;
  sql.prepare("UPDATE users SET points = 0").run();
  stmt.resetAllBuckets.run();
  stmt.insertHistory.run(
    "ALL", "ALL", 0, "[Admin] all points reset", new Date().toISOString()
  );
  stmt.trimHistory.run();
  return count;
});

function resetAllPoints() {
  return resetAllTx();
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────
// On SIGINT/SIGTERM, close the DB so WAL is checkpointed cleanly.
function closeDb() {
  try { sql.close(); } catch {}
}
process.on("exit",    closeDb);
process.on("SIGINT",  () => { closeDb(); process.exit(0); });
process.on("SIGTERM", () => { closeDb(); process.exit(0); });

module.exports = {
  getUser,
  addPoints,
  deductPoints,
  incrementStat,
  getLeaderboard,
  getMonthlyLeaderboard,
  getUserRank,
  getAllHistory,
  currentMonthKey,
  previousMonthKey,
  getMonthPoints,
  markSynced,
  hasReactionAward,
  recordReactionAward,
  cleanupReactionAwards,
  getDailyFirst,
  setDailyFirst,
  resetPoints,
  resetAllPoints,
  // Exposed for tests / introspection only:
  _sql: sql,
};
