# Overview card for Claude Code

Brings back the usage overview card that used to sit on the Claude desktop app's start screen, and adds more:

- **Overview tiles:** sessions, messages, total tokens, active days, peak hour and favorite model, for all time, the last 30 days or the last 7 days.
- **Activity heatmap:** one square per day, brighter for busier days.
- **Models tab:** tokens per model.
- **Limits:** your 5-hour limit, weekly limit and context window as bars. They're blue normally, orange from 70% and red from 90%.
- **Numbers for each limit:** messages, tokens, tokens per model and API value for the current 5-hour window, the current weekly window and the chat you're in.
- **Lifetime API value:** what all your Claude Code usage would cost at Claude API list prices. You don't pay this on a subscription. It's there for interest.

It reads only files Claude Code already keeps on your computer: `stats-cache.json` and the session logs in your `.claude` folder. The mod sends nothing anywhere itself. If you turn on sync between computers, it writes one numbers-only file to your OneDrive.

## The easy way: ask Claude

Open Claude Code and say:

> Install the Claude Code mod from https://github.com/NoLimitAlex/claude-overview-card. Follow its CLAUDE.md.

Claude downloads it, installs it, and tells you when to restart. The steps it follows are in [CLAUDE.md](CLAUDE.md).

**For AI assistants:** the install, edit and test steps for this repository are in [CLAUDE.md](CLAUDE.md). Follow them in order.

## What you need

- **Claude Code**, signed in with a Claude subscription. Check it's installed by running `claude --version` in a terminal.
- **Node.js 18 or newer**, which counts your recent usage. Check with `node --version`, or install it from nodejs.org.

## Install it yourself

1. Download it into a folder you'll keep. Either clone it:

```
git clone https://github.com/NoLimitAlex/claude-overview-card.git "C:\Users\<your name>\claude-mods\overview-card"
```

   or use **Code → Download ZIP** on GitHub and unzip it to that folder.

2. In a terminal, run these two commands, using the folder from step 1:

```
claude plugin marketplace add "C:\Users\<your name>\claude-mods\overview-card"
claude plugin install overview-card@lepi-mods
```

3. Start Claude Code, or type `/reload-plugins` in a session that's already open.

The card opens when Claude Code starts. Type `/overview` to bring it back after you close it. Press Esc at an empty prompt to close it. The limit bars fill in after your first message in a session.

## Sync usage across computers

If you use Claude Code on more than one computer, the card can add them all up. The limit bars already cover your whole account. Sync adds the other computers to the messages, tokens, heatmap and API values too.

1. Install the mod on each computer.
2. On one of them, make a folder called `claude-usage` in your OneDrive. OneDrive copies it to your other computers, and the card switches sync on wherever it finds that folder.

Each computer writes one small file there, named after the computer, holding only numbers: totals per day and per model, and 10-minute slices of the last 8 days. Chats, code and file names are never copied. The card's Lifetime line shows how many computers it's counting. "This session" always means the chat you're in.

To use another synced folder, like Dropbox, set the `CLAUDE_USAGE_SYNC_DIR` environment variable to it. To stop syncing on a computer, delete that computer's file and remove the folder, or don't create it at all.

## Edit it yourself

Claude Code reads the mod straight from the folder you installed from. Edit any file, then type `/reload-plugins` in Claude Code to see the change.

| To change | Edit |
|---|---|
| The layout of the top of the card: tiles, tabs, heatmap | `hooks/register.tsx` |
| The look of the limits section: colors, bars, the number cards | `hooks/usage-view.ts` |
| How numbers are added up, the heatmap colors, the Dune line | `hooks/stats.ts` |
| How recent days and API values are counted from the logs | `scripts/recent-stats.mjs` |
| Syncing usage between computers | `scripts/sync.mjs` |
| The API prices per model | `scripts/pricing.mjs` |

The easiest way is to ask Claude Code. Open a session in this folder and describe the change, for example: "make the bars green" or "add a tile for tool calls".

To check your changes, run these in the mod's folder:

```
claude plugin validate .
claude plugin test .
```

## Remove it

```
claude plugin uninstall overview-card@lepi-mods
```
