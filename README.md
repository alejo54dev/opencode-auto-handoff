# auto-handoff

OpenCode plugin — periodic + exit handoff writer, startup handoff reader via `.md` files.

**No database.** `.handoff/*.md` is the only persistence.

## What it does

- **Periodic save** — writes new handoff every N user-turns (default 10)
- **Exit save** — writes handoff when opencode closes (dispose + process.exit)
- **Startup load** — reads latest handoff on plugin load, injects into context as synthetic user message

No keywords. Automatic snapshots + automatic resume.

## Install

```bash
cp auto-handoff.ts ~/.config/opencode/plugins/
```

## Config

See `AGENTS.md` for canonical config schema and defaults.

## Verify

See `AGENTS.md` for verification commands.

## Related

- [handoff skill](../../.config/opencode/skills/handoff) — manual trigger, reads + summarizes handoffs
- [auto-handoff skill](../../.config/opencode/skills/auto-handoff) — bundled manual override (save/load now)
