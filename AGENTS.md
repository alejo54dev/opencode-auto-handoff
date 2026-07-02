# AGENTS.md

## Project

OpenCode plugin — periodic + exit handoff writer via `.md` files. Single-file TypeScript, runs on Bun. No database — `.handoff/*.md` is the only persistence.

## Stack

- **Runtime:** Bun (uses `node:fs`, `node:path`)
- **Storage:** `<project>/.handoff/<timestamp>.md` (plain markdown files)
- **Build:** `bun build --target=bun`

## File layout

```
auto-handoff/
├── auto-handoff.ts          # source (single file)
├── README.md
├── AGENTS.md
└── .handoff/               # session handoffs (gitignored)
```

## Deploy

See script header (`auto-handoff.ts:8`) for install path. Canonical load path: `plugins/` only.

## Verify

```bash
ls ~/.config/opencode/plugins/auto-handoff.ts
# expect: file exists

ls .handoff/
# expect: *.md files (after session activity)
```

## Config

Config is passed via opencode plugin options in `opencode.json` (no external config file):

```json
{
	"plugin": [
		["auto-handoff", {
			"every_n_turns": 10,
			"on_exit": true,
			"recent_messages_count": 10,
			"log_level": "info"
		}]
	]
}
```

Logs go to stdout/stderr (captured by opencode). No log file.

## Behavior

| trigger | when | action |
|---|---|---|
| `every_n_turns` | user-turn count reaches N | write new `.handoff/<ts>.md` |
| `dispose` hook | clean shutdown | write handoff (if `on_exit: true`) |
| `process.once("exit")` | session ends | write handoff (5s guard prevents double-write with dispose) |

## Output format

```markdown
# Handoff — 2026-07-02-1215

## Reason
periodic (10 turns)

## Recent messages (last 10)
- [user] hola
- [assistant] hola. sesión cargada...
- [user] tengo un gato llamado mishi
- [assistant] turno 1/10+. continúa.
- ...
```

## Conventions

- Tabs, Allman braces, spaces inside parens/brackets (see `my-coding-preferences` skill).
- Version: patch bump only (`1.0.x`) per coding rules.
- No comments unless asked.
- English-only artifacts.

## Key invariants

- No database — only `.handoff/*.md` files.
- No keywords, no load — write-only, periodic + exit.
- In-memory message buffer (last N messages) for handoff content.
- Dedup: skip message if identical to last in buffer.
- `process.once("exit")` registered, removed in `dispose`.
- 5s time guard prevents double-write between `dispose` and `exit`.

## Plugin hooks

| Hook | Purpose |
|---|---|
| `experimental.chat.messages.transform` | Count user turns, write handoff every N |
| `process.once("exit")` | Auto-write on session end |
| `dispose` | Cleanup (remove listener, auto-write) |

## Do not

- Do not bump major version without explicit user request.
- Do not push without explicit user request.
- Do not add database dependency — file-only by design.
- Do not copy `auto-handoff.ts` to `~/.config/opencode/` root. Only `plugins/` is canonical.
- Do not add external config files or log files — plugin lives entirely within opencode context.
- Do not duplicate script header info (paths, install, config example) across md files.
