---
name: auto-handoff
description: >
 Manual trigger for the auto-handoff plugin.
 Force a handoff write before the periodic N-turns (save handoff now, guardar handoff, write handoff).
 Force a handoff read on demand (load handoff, cargar handoff, read handoff).
 Use when the user wants immediate snapshot or immediate resume without waiting for the plugin's automatic triggers.
argument-hint: "[save|load]"
---

# Auto-Handoff

The `auto-handoff` plugin already writes `.handoff/<ts>.md` every N user-turns and on session exit, and reads the latest handoff on plugin load. This skill provides **manual overrides** for those operations.

## Save (force write now)

1. Detect project root — `git rev-parse --show-toplevel` (fallback: `pwd`).
2. Create directory `<PROJECT_ROOT>/.handoff/` if missing.
3. Write handoff doc there with timestamp `YYYY-MM-DD-HHMM.md`.

- Include a "suggested skills" section suggesting skills the next agent should invoke.
- Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.
- Redact any sensitive information (API keys, passwords, PII).
- If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

## Load (force read now)

1. Detect project root (same logic as Save).
2. Look for the most recent file in `<PROJECT_ROOT>/.handoff/` (sorted by name, descending).
3. If found, read it and present the summary to the user.

## Project detection

```bash
# Get project root (git root or cwd)
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
```

## When to use

- **Save now** — user says "save handoff", "guardar handoff", "write handoff", "snapshot now", or wants to checkpoint before a risky operation.
- **Load now** — user says "load handoff", "cargar handoff", "read handoff", "resume now", or wants to see the latest snapshot without restarting opencode.

Otherwise, let the plugin handle it automatically.
