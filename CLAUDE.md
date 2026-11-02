# Guide for AI assistants

This repository is a Claude Code mod (a plugin made of function hooks) called `overview-card`. It draws a usage dashboard in Claude Code: overview tiles, an activity heatmap, the plan's limit bars, and messages, tokens and API value for each limit window, the current chat and lifetime.

## Installing it for the user

When the user asks you to install this mod, do these steps in order. Tell the user what you're doing as you go.

1. **Check what's needed.** Run `claude --version` and `node --version`. Claude Code must be installed, and Node.js must be 18 or newer. If Node.js is missing, tell the user to install it from nodejs.org and stop until they have.
2. **Download it into a folder the user keeps.** The mod is read from this folder, and edits there take effect, so don't use a temporary folder. The default is `claude-mods/overview-card` in the user's home folder:

   ```
   git clone https://github.com/NoLimitAlex/claude-overview-card.git "<home>/claude-mods/overview-card"
   ```

   Replace `<home>` with the user's home folder. If git isn't installed, download `https://github.com/NoLimitAlex/claude-overview-card/archive/refs/heads/main.zip` and unzip it instead. The zip holds one folder, `claude-overview-card-main`: move its contents to `<home>/claude-mods/overview-card`.
3. **Register and install it**, using the absolute path of that folder:

   ```
   claude plugin marketplace add "<home>/claude-mods/overview-card"
   claude plugin install overview-card@lepi-mods
   ```

4. **Check it.** `claude plugin list` should show `overview-card@lepi-mods` as enabled.
5. **Tell the user how to see it.** Restart Claude Code, or type `/reload-plugins` in a session that's already open. The card opens on its own; `/overview` reopens it. The limit bars fill in after their first message in a session.

Don't change the user's settings files by hand, and don't install it any other way unless the user asks.

## What it reads

Only files Claude Code already keeps: `stats-cache.json` and the session logs (`projects/**/*.jsonl`) in the Claude config folder (`~/.claude`, or `CLAUDE_CONFIG_DIR` if set). It sends nothing anywhere itself. With sync on (below) it also writes one numbers-only summary file to the shared folder, which the user's OneDrive then syncs. The bundled Node script `scripts/recent-stats.mjs` counts the days `stats-cache.json` hasn't covered yet and prices usage with `scripts/pricing.mjs`.

## Syncing usage across the user's computers

Sync is off unless a shared folder exists. The card uses `CLAUDE_USAGE_SYNC_DIR` when it's set, otherwise a folder called `claude-usage` in OneDrive (`%OneDrive%\claude-usage`). If the user wants their computers added together, make that folder in their OneDrive, after checking that OneDrive is signed in to the same account on each computer. Each computer writes `<computer name>.usage.json` there with numbers only, and adds up the others. Never put anything else in that folder.

## Editing it for the user

Claude Code reads the mod straight from the folder it was installed from. After any edit, the user types `/reload-plugins` to see it.

| File | What it controls |
|---|---|
| `hooks/register.tsx` | Hooks, the `/overview` command, the card's layout: tiles, tabs, heatmap |
| `hooks/usage-view.ts` | The limits section: bars, colors, number cells, the desktop SVG |
| `hooks/stats.ts` | Totals, ranges, heatmap levels and colors, number formatting |
| `scripts/recent-stats.mjs` | Counting recent days, limit windows and the current session from the logs |
| `scripts/pricing.mjs` | API list prices per model |
| `scripts/sync.mjs` | The shared-folder sync: writing this computer's summary and adding up the others |
| `types/index.d.ts` | The types of the values the card keeps in session state |
| `tests/overview.test.ts` | Tests |

Rules that matter here:

- The hooks module runs with no Node and no DOM. Everything outside it goes through `$`. A helper that takes `$` must be a top-level function in `register.tsx`, or `claude plugin validate` refuses it.
- Render hooks can't write state. Write from handlers, timers or other events.
- When you change what the counter outputs, change the `shape` tag on the `recent` atom in `register.tsx`, so numbers saved by the old version are ignored.

After every change, run these in the repository folder and fix what they report:

```
claude plugin validate .
claude plugin test .
```

## Removing it

```
claude plugin uninstall overview-card@lepi-mods
```
