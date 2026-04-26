const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "data", "points.json");

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, "data"))) {
  fs.mkdirSync(path.join(__dirname, "data"));
}

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: {}, monthly: {}, history: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function getUser(userId, username) {
  const db = loadDB();
  if (!db.users[userId]) {
    db.users[userId] = {
      id: userId,
      username,
      points: 0,
      monthlyPoints: 0,
      stats: {
        challenges: 0,
        messages: 0,
        reactions: 0,
        voiceMinutes: 0,
        helpfulAnswers: 0,
        invites: 0,
      },
    };
    saveDB(db);
  }
  // Update username in case it changed
  db.users[userId].username = username;
  saveDB(db);
  return db.users[userId];
}

// Returns the current month key e.g. "2026-04"
function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function addPoints(userId, username, amount, reason) {
  const db = loadDB();
  getUser(userId, username); // Ensure user exists

  const mk = currentMonthKey();
  // monthlyBuckets: { "2026-04": 120, "2026-05": 45 ... }
  if (!db.users[userId].monthlyBuckets) db.users[userId].monthlyBuckets = {};
  db.users[userId].monthlyBuckets[mk] = (db.users[userId].monthlyBuckets[mk] || 0) + amount;

  // Keep running all-time total
  db.users[userId].points += amount;

  // Log to history
  db.history.push({
    userId,
    username,
    amount,
    reason,
    timestamp: new Date().toISOString(),
  });

  // Keep history to last 1000 entries
  if (db.history.length > 1000) db.history = db.history.slice(-1000);

  saveDB(db);
  return db.users[userId];
}

function deductPoints(userId, username, amount, reason) {
  const db = loadDB();
  getUser(userId, username);

  const mk = currentMonthKey();
  if (!db.users[userId].monthlyBuckets) db.users[userId].monthlyBuckets = {};
  db.users[userId].monthlyBuckets[mk] = Math.max(
    0,
    (db.users[userId].monthlyBuckets[mk] || 0) - amount
  );
  db.users[userId].points = Math.max(0, db.users[userId].points - amount);

  db.history.push({
    userId,
    username,
    amount: -amount,
    reason,
    timestamp: new Date().toISOString(),
  });

  if (db.history.length > 1000) db.history = db.history.slice(-1000);
  saveDB(db);
  return db.users[userId];
}

function incrementStat(userId, username, stat) {
  const db = loadDB();
  getUser(userId, username);
  if (db.users[userId].stats[stat] !== undefined) {
    db.users[userId].stats[stat]++;
  }
  saveDB(db);
}

// Returns points for a user in a given month key (defaults to current month)
function getMonthPoints(user, mk) {
  const key = mk || currentMonthKey();
  return (user.monthlyBuckets && user.monthlyBuckets[key]) || 0;
}

// All-time leaderboard sorted by total points, supports top N or bottom N
function getLeaderboard(limit = 10, order = "top") {
  const db = loadDB();
  const sorted = Object.values(db.users).sort((a, b) => b.points - a.points);
  if (order === "last") {
    return sorted.slice(-limit).reverse(); // lowest first
  }
  return sorted.slice(0, limit);
}

// Monthly leaderboard for the current month
function getMonthlyLeaderboard(limit = 10) {
  const db = loadDB();
  const mk = currentMonthKey();
  return Object.values(db.users)
    .sort((a, b) => getMonthPoints(b, mk) - getMonthPoints(a, mk))
    .slice(0, limit);
}

// Returns rank info for a single user
function getUserRank(userId) {
  const db = loadDB();
  const sorted = Object.values(db.users).sort((a, b) => b.points - a.points);
  const rank = sorted.findIndex((u) => u.id === userId) + 1;
  const user = db.users[userId];
  const mk = currentMonthKey();
  return {
    rank: rank === 0 ? null : rank,
    user,
    total: sorted.length,
    monthlyPoints: user ? getMonthPoints(user, mk) : 0,
  };
}

function markSynced(userId) {
  const data = loadDB();
  if (data.users[userId]) {
    data.users[userId].synced = true;
    saveDB(data);
  }
}

function getAllHistory(limit = 20) {
  const db = loadDB();
  return db.history.slice(-limit).reverse();
}

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
  getMonthPoints,
  markSynced,
};