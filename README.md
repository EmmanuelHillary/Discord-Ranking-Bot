# 🏆 Discord Community Ranking Bot

A fully self-contained Discord bot that gamifies your server. Members earn points automatically through everyday activity, admins award bonus points for community challenges, and a dedicated **#ranking** channel keeps a live, beautiful leaderboard pinned at all times.

---

## 📁 Folder Structure

```
discord-ranking-bot/
│
├── index.js          ← Main bot file. All Discord events & commands live here.
├── database.js       ← All data read/write logic. Uses a local JSON file.
├── embeds.js         ← Builds every Discord embed (leaderboard, rank card, etc.)
├── config.js         ← All point values and settings. Edit this to tune the bot.
├── package.json      ← Project metadata and dependency list.
├── .env              ← Your private secrets. YOU create this from .env.example.
├── .env.example      ← Template showing which values you need to fill in.
│
└── data/
    └── points.json   ← Auto-created on first run. All points live here.
                         Back this file up regularly — it is your database.
```

> **You only need to create `.env` yourself.** Everything else is already written.
> The `data/` folder and `points.json` are created automatically on first run.

---

## ⚙️ Setup — Step by Step

### Step 1 — Create the Discord Bot

1. Go to https://discord.com/developers/applications
2. Click **New Application** → give it a name → **Create**
3. In the left sidebar click **Bot**
4. Click **Reset Token** and copy the token — you will need it shortly
5. Scroll down to **Privileged Gateway Intents** and enable all three:
   - ✅ Presence Intent
   - ✅ Server Members Intent
   - ✅ Message Content Intent
6. Click **Save Changes**

### Step 2 — Invite the Bot to Your Server

1. In the left sidebar click **OAuth2 → URL Generator**
2. Under **Scopes** check: `bot` and `applications.commands`
3. Under **Bot Permissions** check:
   - View Channels
   - Send Messages
   - Manage Messages
   - Read Message History
   - Add Reactions
   - Manage Channels (needed to auto-create #ranking if it does not exist)
   - Connect / View Voice Activity
4. Copy the generated URL at the bottom → open in browser → invite to your server

### Step 3 — Collect Your IDs

Enable Developer Mode in Discord first:
**User Settings → Advanced → Developer Mode → ON**

| What | How to get it |
|---|---|
| CLIENT_ID | Discord Dev Portal → Your App → General Information → Application ID |
| GUILD_ID | Right-click your server name → Copy Server ID |
| RANKING_CHANNEL_ID | Right-click your #ranking channel → Copy Channel ID (or leave blank — bot will create it) |

### Step 4 — Create Your .env File

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_client_id
GUILD_ID=your_server_id
RANKING_CHANNEL_ID=your_ranking_channel_id
```

Never share your .env file. It contains your bot token.

### Step 5 — Install and Run

```bash
npm install
npm start
```

You should see output like:
```
✅ Logged in as YourBot#1234
✅ Slash commands registered.
✅ Member sync — 47 members scanned, 47 newly registered.
✅ Created #ranking channel: 1234567890
```

---

## 🚀 Running 24/7 (Production)

```bash
npm install -g pm2
pm2 start index.js --name "ranking-bot"
pm2 save
pm2 startup
```

Useful commands:
```bash
pm2 logs ranking-bot      # Live logs
pm2 restart ranking-bot   # Restart
pm2 stop ranking-bot      # Stop
pm2 status                # See all processes
```

---

## 💰 Points System

### Auto-tracked

| Activity | Points | Notes |
|---|---|---|
| 💬 Send a message | 0.5 | 10s cooldown to prevent spam |
| 👍 Add a reaction | 0.5 | 5s cooldown |
| 🎙️ Voice chat | 0.5 per min | Credited when you leave. Min 1 minute. |
| 🌅 First message of the day | +2 bonus | Resets at midnight UTC |
| 📝 Long message (200+ chars) | +1 bonus | Stacks with message points |
| 📎 Share a file or image | +0.5 | Any attachment |
| 🧵 Create a thread | 1 | Awarded to the thread creator |

### Manual (admin commands only)

| Activity | Points |
|---|---|
| ✅ Solve Community Challenge | 50 |
| ✨ Helpful answer | 5 |
| 🤝 Invite a new member | 10 |

---

## 🎮 Commands

### Everyone

| Command | What it does |
|---|---|
| `/rank @user` | Individual rank card — rank, points, progress bar, activity stats |
| `/rank` | Top 10 leaderboard |
| `/rank top 50` | Top 50 players |
| `/rank last 50` | Bottom 50 players |
| `/rank top 500` | Top 500 (maximum) |
| `/history` | Last 15 point events (only visible to you) |
| `/leaderboard` | Top 20 leaderboard embed |

### Admins Only (requires Manage Server permission)

| Command | What it does |
|---|---|
| `/addpoints @user 50 "Solved Challenge #5"` | Award points manually |
| `/deductpoints @user 10 "Reason"` | Deduct points (cannot go below 0) |

---

## 🏅 Rank Tiers

| Points | Title |
|---|---|
| 0 | 🪨 Newcomer |
| 50 | 🌱 Rising Star |
| 150 | ⚡ Active Member |
| 350 | 🔥 Engaged |
| 700 | 💎 Community Gem |
| 1,200 | 🏆 Elite |
| 2,500 | 👑 Legend |

---

## 📺 Monthly MVP

- The #ranking channel always shows who is currently leading this month
- On the 1st of every month the bot announces the MVP in #ranking
- The MVP earns the right to suggest the next video idea 🎬
- Points are never reset — totals keep growing, but each calendar month is tracked separately

---

## 📌 The #ranking Channel

The bot posts exactly 3 pinned messages and edits them every 5 minutes:

1. **Point System & MVP** — Current month leader, full points table, rank tiers
2. **Top 20 Leaderboard** — Live standings, medals for top 3, monthly pts shown per user
3. **Commands Guide** — Full command reference for members and admins

The channel is read-only for members. Only the bot can post there.

---

## 👥 Member Coverage

- On startup: bot fetches every member and registers them all (including lurkers at 0 pts)
- On new join: bot registers the member instantly before they've said anything
- Result: /rank @user always works for any member on the server

---

## 🔧 Customising

All point values are in `config.js`. Change numbers there only — no other file needs touching.

To add a new rank tier, add to the `RANK_TITLES` array in `config.js`:
```js
{ min: 5000, label: "🌟 Mythic" },
```

---

## 💾 Backing Up

All data is in `data/points.json`. Back it up regularly:

```bash
cp data/points.json data/points-backup-$(date +%F).json
```

If this file is lost, all points are lost. It is small and easy to back up.

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| Slash commands not showing | Wait up to 1 hour, or check CLIENT_ID and GUILD_ID in .env |
| "Missing Access" error | Bot needs Send Messages + Manage Messages in #ranking |
| Member sync shows 0 new | Members were already registered — normal on restarts |
| Voice not tracking | Bot needs View Channel + Connect on your voice channels |
| Messages not giving points | Enable Message Content Intent in the Developer Portal |
