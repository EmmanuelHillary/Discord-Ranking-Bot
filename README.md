# 🏆 Discord Community Ranking Bot

A self-contained Discord bot that gamifies your server. Members earn points automatically through everyday activity, admins award bonus points for community challenges, and a dedicated **#ranking** channel keeps a live, beautiful leaderboard pinned at all times — with built-in anti-farm enforcement.

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
    ├── points.db          ← SQLite database. All points live here.
    ├── points.db-wal      ← Write-ahead log. Don't delete while bot is running.
    ├── points.db-shm      ← Shared-memory file. Auto-managed by SQLite.
    └── points.json.migrated ← (Only present after first boot if you previously
                                ran the JSON version. Safe to keep as a rollback.)
```

> **You only need to create `.env` yourself.** Everything else is already written.
> The `data/` folder and `points.db` are created automatically on first run.
> If you're upgrading from the JSON version, the old `points.json` is auto-imported
> on first boot and renamed to `points.json.migrated` — no action required.

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
   - Manage Channels (needed to lock down #ranking permissions)
   - Read Message History
   - Add Reactions
   - Embed Links
   - Attach Files
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

Never share your `.env` file. It contains your bot token.

### Step 5 — Install and Run

```bash
npm install
npm start
```

You should see output like:
```
✅ Logged in as YourBot#1234
✅ Slash commands registered.
✅ Member sync — 47 total, 47 newly registered.
✅ Permissions locked down on #ranking (read-only for members)
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
| 👍 Add a reaction | **0.05** | **One award per message, per user.** Re-reacting never re-credits. 15s cooldown. |
| 🎙️ Voice chat | 0.5 per min | Min 5 effective minutes. Time spent **alone or self-deafened does not count.** |
| 🌅 First message of the day | +2 bonus | Resets at midnight UTC. **Persisted** — restarts won't re-award. |
| 📝 Long message (200+ chars) | +1 bonus | Stacks with message points |
| 📎 Share a file or image | +0.5 | Any attachment |
| 🧵 Create a thread | 1 | 5 min cooldown per user — thread spam earns nothing |

### Manual (admin commands only)

| Activity | Points |
|---|---|
| ✅ Solve Community Challenge | 50 |
| ✨ Helpful answer | 2 |
| 🤝 Invite a new member | 2 |

---

## 🛡️ Anti-Farm System

Members try to game any points system. The bot **automatically deducts 10 points** every time it detects one of the following patterns:

| Detection | What it catches |
|---|---|
| Repeated identical messages | Same content sent ≥ 3 times within 10 minutes |
| Self-reaction | Reacting to your own message |
| Reaction burst | More than 8 reactions in 60 seconds |
| Voice rejoin spam | Joining/leaving voice ≥ 4 times in 5 minutes |

A penalty cooldown (60s per user) prevents penalty-stacking from a single sustained burst. All deductions are written to `/history` with reason `[Anti-farm] …` so admins have a paper trail.

In addition, the bot **silently ignores** these zero-value patterns instead of penalising:

- Reactions to bot messages (no points)
- Reactions on a message a user has already been credited for (no points, ever)
- Voice minutes while alone in channel (no points)
- Voice minutes while self-deafened (no points)

The rules are also displayed in **bold** inside the pinned point-system embed, so every member sees them every time they open #ranking.

Tune the thresholds in `config.js` under the `FARM_*` constants.

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
| `/history` | Last 15 point events |
| `/leaderboard` | Top 20 leaderboard embed |

### Admins (requires **Manage Server** permission)

| Command | What it does |
|---|---|
| `/addpoints @user 50 "Solved Challenge #5"` | Award points manually |
| `/deductpoints @user 10 "Reason"` | Deduct points (cannot go below 0) |

### Server Administrator only

| Command | What it does |
|---|---|
| `/resetpoints @user` | Reset a single user's total + monthly buckets to 0 |
| `/resetpoints confirm:CONFIRM` | **Server-wide reset.** Wipes every member's points and monthly buckets. Stats (messages, voice mins, etc.) are preserved. |

`/resetpoints` requires the **Administrator** permission, and a server-wide reset additionally requires the literal string `CONFIRM` in the `confirm` option to prevent accidents.

---

## 🏅 Rank Tiers

| Points | Title |
|---|---|
| 0 | 😝 Newcomer |
| 50 | 🌱 Rising Star |
| 150 | ⚡ Active Member |
| 350 | 🔥 Engaged |
| 700 | 💎 Community Gem |
| 1,200 | 🏆 Elite |
| 2,500 | 👑 Legend |

---

## 📺 Monthly MVP

- The pinned point-system embed in #ranking always shows **this month's** current leader
- On the 1st of every month at 00:00 server-time the bot announces the **previous month's** MVP in #ranking — sourced from the previous-month bucket so the message is always correct
- The MVP earns the right to suggest the next video idea 🎬
- Points are never reset by the schedule — totals keep growing, but each calendar month is tracked separately

---

## 📌 The #ranking Channel

The channel is locked down on every startup. Members can **view and read history only**. The bot **automatically denies**:

- `SendMessages`
- `AddReactions`
- `CreatePublicThreads`
- `CreatePrivateThreads`
- `SendMessagesInThreads`
- `AttachFiles`
- `EmbedLinks`

The bot is the only account that can post or edit there. It maintains exactly 3 pinned messages and edits them every 5 minutes:

1. **Point System & MVP** — Current month leader, full points table, fair-play / anti-farm rules, rank tiers
2. **Top 20 Leaderboard** — Live standings, medals for top 3, monthly pts shown per user
3. **Commands Guide** — Full command reference for members and admins

---

## 👥 Member Coverage

- On startup: bot fetches every member and registers them all (including lurkers at 0 pts)
- On new join: bot registers the member instantly before they've said anything
- Result: `/rank @user` always works for any member on the server

---

## 🔧 Customising

All point values, cooldowns, and anti-farm thresholds live in `config.js`. Change numbers there only — no other file needs touching.

To add a new rank tier, add to the `RANK_TITLES` array in `config.js`:
```js
{ min: 5000, label: "🌟 Mythic" },
```

To loosen or tighten anti-farm detection, edit the `FARM_*` constants — for example `FARM_REPEAT_THRESHOLD` controls how many identical messages trigger a deduction.

---

## 💾 Backing Up

All data lives in `data/points.db` (SQLite). The recommended way to back it up
**while the bot is running** is via SQLite's online-backup API — this is atomic
and produces a consistent snapshot even mid-write:

```bash
sqlite3 data/points.db ".backup data/points-backup-$(date +%F).db"
```

A plain `cp` works only when the bot is stopped, because it can race with WAL
checkpoints. The `.backup` command above is the safe equivalent.

To inspect the database directly:

```bash
sqlite3 data/points.db "SELECT username, points FROM users ORDER BY points DESC LIMIT 10;"
sqlite3 data/points.db "SELECT * FROM history ORDER BY id DESC LIMIT 20;"
```

The `reaction_awards` table holds one row per credited reaction; a daily cron at
04:00 prunes rows older than 30 days. The `history` table is auto-trimmed to
the last ~1,000 events.

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| Slash commands not showing | Wait up to 1 hour, or check `CLIENT_ID` and `GUILD_ID` in `.env` |
| "Missing Access" error | Bot needs Send Messages + Manage Messages + Manage Channels in #ranking |
| Member sync shows 0 new | Members were already registered — normal on restarts |
| Voice not tracking | Bot needs View Channel + Connect on your voice channels. Note: time alone or self-deafened is intentionally ignored. |
| Messages not giving points | Enable **Message Content Intent** in the Developer Portal |
| Reaction not awarding points | The user has likely already been credited for that message — by design, only the first reaction earns |
| Members can still post in #ranking | Restart the bot — permissions are re-applied on startup. Make sure the bot's role is **above** the roles whose access you're locking down. |
| `better-sqlite3` install fails | Your host has no prebuilt binary. Install build tools (`apt install build-essential python3` on Debian/Ubuntu) and rerun `npm install`. Most managed hosts (Railway, Render, Fly) ship a working toolchain by default. |
| Want to roll back to JSON | The original file is preserved at `data/points.json.migrated`. Stop the bot, rename it back to `points.json`, delete `points.db*`, and check out a previous commit of `database.js`. |
