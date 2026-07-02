---
name: auto-handoff
description: >
 Reference for the auto-handoff plugin.
 Documents the automatic periodic + exit handoff writer and the startup handoff reader.
 No manual triggers — the plugin handles everything automatically.
---

# Auto-Handoff

The `auto-handoff` plugin runs automatically. No keywords, no manual triggers.

## What it does

- **Periodic save** — writes `.handoff/<ts>.md` every N user-turns (default 10)
- **Exit save** — writes handoff when opencode closes (dispose + process.exit)
- **Startup load** — reads latest handoff on plugin load, injects into context as synthetic user message

## File format

Handoffs are stored at `<project>/.handoff/<timestamp>.md` (plain markdown).

```markdown
# Handoff — 2026-07-02-1215

## Reason
periodic (10 turns)

## Recent messages (last 10)
- [user] hola
- [assistant] hola. sesión cargada...
- ...
```

## Config

Canonical config at `~/.config/opencode/auto-handoff.json`:

```json
{
	"every_n_turns": 10,
	"on_exit": true,
	"on_start": true,
	"recent_messages_count": 10,
	"log_level": "info"
}
```

Logs go to `~/.config/opencode/auto-handoff.log`.

## Why no triggers

The plugin automates everything. Manual triggers add friction without value. If you need to force a write or read, restart opencode — the plugin handles it on load and exit.
