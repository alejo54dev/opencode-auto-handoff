# AGENTS.md

## Project

OpenCode plugin — periodic + exit handoff writer, startup handoff reader via `.md` files. Single-file TypeScript, runs on Bun. No database — `.handoff/*.md` is the only persistence.

## Stack

- **Runtime:** Bun (uses `node:fs`, `node:os`, `node:path`)
- **Storage:** `<project>/.handoff/<timestamp>.md` (plain markdown files)
- **Build:** `bun build --target=bun`

## File layout

```
auto-handoff/
├── auto-handoff.ts          # source (single file)
├── README.md
├── AGENTS.md
├── skills/
│   └── auto-handoff/
│       └── SKILL.md         # bundled skill (manual save/load override)
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

tail -f ~/.config/opencode/auto-handoff.log
# expect: "Handoff written (periodic|exit|dispose): ..." and "Handoff loaded: ..." entries
```

## Config

Canonical config at `~/.config/opencode/auto-handoff.json`.
Values `keep_last`, `max_stored_files`, `max_load_files` clamp to minimum 1.

```json
{
	"every_turns": 20,
	"on_exit": true,
	"on_start": true,
	"keep_last": 20,
	"max_stored_files": 10,
	"max_load_files": 3,
	"log_level": "info"
}
```

Logs go to `~/.config/opencode/auto-handoff.log`.

## Behavior

| trigger | when | action |
|---|---|---|
| `every_turns` | message count (user + assistant) reaches N. `0` = never periodic (only dispose/exit) | write new `.handoff/<ts>.md` |
| `dispose` hook | clean shutdown | write handoff (if `on_exit: true`) |
| `process.once("exit")` | session ends | write handoff (5s guard prevents double-write with dispose) |
| `on_start` | plugin load | read latest `.handoff/<ts>.md` files (via `readdirSync`, not glob), inject as system prompt on first system.transform |

## Output format

```markdown
# Handoff — 2026-07-02-1215

## Reason
periodic (10 messages)

## Recent messages (last 10)
- [user] hola
- [assistant] hola. sesión cargada...
- [user] tengo un gato llamado mishi
- [assistant] turno 1/10+. continúa.
- ...
```

## Conventions

- Tabs, Allman braces, spaces inside parens/brackets (see `my-coding-preferences` skill).
- Version: always patch bump (`1.0.x`). No minor/major bumps.
- No comments unless asked.
- English-only artifacts.
- **Docblock lines: NO leading space before `*`.** Format is `*\t<tag>` (tab after asterisk), never ` *\t<tag>`. This applies to ALL `/** ... */` blocks in `.ts` files.

## Key invariants

- No database — only `.handoff/*.md` files.
- In-memory message buffer (last N messages) for handoff content.
- Buffer messages are tagged `role: "user" | "assistant"`. Only the synthetic `handoff-resume` message is excluded from the buffer.
- Dedup: skip message if identical to last in buffer.
- `process.once("exit")` registered, removed in `dispose`.
- 5s time guard prevents double-write between `dispose` and `exit`.
- `on_start` reads latest handoff via `readdirSync` (glob fails on `.handoff` dotdir), injects once per session as system prompt (not as user message — prevents template contamination of subsequent handoffs).

## Plugin hooks

| Hook | Purpose |
|---|---|
| `experimental.chat.system.transform` | Inject pending handoff as system prompt on first call |
| `experimental.chat.messages.transform` | Capture user + assistant messages, write handoff every N |
| `process.once("exit")` | Auto-write on session end |
| `dispose` | Cleanup (remove listener, auto-write) |

## Do not

- Do not bump major version without explicit user request.
- Do not push without explicit user request.
- Do not add database dependency — file-only by design.
- Do not copy `auto-handoff.ts` to `~/.config/opencode/` root. Only `plugins/` is canonical.
- Do not duplicate script header info (paths, install, config example) across md files.
- Do not leave backup files (`.bak`, `.old`, etc.) inside `~/.config/opencode/plugins/`. The plugin loader may pick them up. Backups belong in the workdir or `/tmp/opencode/`.
