# auto-handoff

OpenCode plugin — periodic + exit handoff writer via `.md` files.

**No database.** `.handoff/*.md` is the only persistence.

## What it does

- **Periodic save** — writes new handoff every N user-turns (default 10)
- **Exit save** — writes handoff when opencode closes (dispose + process.exit)

No keywords, no auto-load. Just automatic snapshots.

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
