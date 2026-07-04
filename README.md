# Auto Handoff — (your session is safe)

Closed opencode and came back the next day without context? This plugin brings it back automatically.

Every N messages it saves a snapshot of your session to a `.md` file. On close, it saves another. On open, it reads the most recent ones and injects them as a user message with sentinel `id: "handoff-resume"`. No commands, no keywords, no database — just text files you can read, version, or delete.

## What it does

- **Periodic save** — writes a handoff every N total messages (user + assistant, default: 20)
- **Save on exit** — writes a handoff when opencode closes
- **Load on start** — reads the latest handoffs when the plugin loads and injects them as a user message with sentinel `id: "handoff-resume"`

Zero keywords. Automatic snapshots + automatic resume.

## Philosophy

This handoff speaks the same language as the model. The format the model writes is the format another model reads. Clean roundtrip, no context loss.

On load, only the message lines (`- [user]` / `- [assistant]`) are extracted from the saved handoff — headers and metadata are discarded, so only conversation content feeds back into context.

## Installation

```bash
cp auto-handoff.ts ~/.config/opencode/plugins/
```

The plugin loads automatically when opencode starts. No manual registration required.

## Configuration

File: `~/.config/opencode/auto-handoff.json`

```json
{
	"every_messages": 20,
	"on_exit": true,
	"on_start": true,
	"keep_last": 20,
	"max_stored_files": 10,
	"max_load_files": 3,
	"log_level": "info"
}
```

| field | default | description |
|---|---|---|
| `every_messages` | `20` | writes a handoff every N messages (user + assistant). `0` = never periodic, only dispose/exit |
| `on_exit` | `true` | writes on session close |
| `on_start` | `true` | reads latest handoffs on start |
| `keep_last` | `20` | how many recent messages each handoff includes (minimum 1) |
| `max_stored_files` | `10` | max `.md` files kept in `.handoff/` (auto-rotation, minimum 1) |
| `max_load_files` | `3` | how many recent handoffs are loaded on start (minimum 1) |
| `log_level` | `"info"` | log level (`silent`, `error`, `info`, `debug`) |

If the file doesn't exist, defaults are used.

## Verification

```bash
ls ~/.config/opencode/plugins/auto-handoff.ts
```

The file should exist.

```bash
ls .handoff/
```

After using opencode for a while, `*.md` files should appear (one per saved handoff).

```bash
tail -f ~/.config/opencode/auto-handoff.log
```

You should see entries like `Handoff written (periodic|exit|dispose): ...`, `Handoff loaded: ...`, and `Handoff injected into context`.

## Output format

Each handoff is a `.md` file in `.handoff/<timestamp>.md`:

```markdown
# Handoff — 2026-07-03-1527

## Reason
periodic (21 messages)

- [user] hola
- [assistant] hola. sesión cargada...
- [user] siguiente mensaje del usuario
- [assistant] respuesta del assistant
- ...
```

Messages are dumped in chronological order with a `[user]` or `[assistant]` prefix to mark the role. Internal markdown content of each message (headers, bold, lists) is preserved as-is.

## How it works

| trigger | when | action |
|---|---|---|
| `every_messages` | message counter (user + assistant) reaches N | writes `.handoff/<ts>.md` |
| `dispose` hook | clean shutdown | writes handoff (if `on_exit: true`) |
| `process.once("exit")` | session ends | writes handoff (structural dedup via `flushMessages()`) |
| `on_start` | plugin load | reads latest `.handoff/<ts>.md` files and stores them as `pendingHandoff` |

**Injection mechanism:** the handoff is injected as a user message with sentinel `id: "handoff-resume"` on the first `messages.transform` call. The synthetic message is excluded from the buffer to prevent template contamination of subsequent handoffs.

**Buffer with tagging:** in-memory messages have role `user` or `assistant`. Only the synthetic resume message (`handoff-resume`) is excluded from the buffer.

**Deduplication:** if a message is identical to the last one in the buffer, it's skipped. Additionally, the last `message.id` seen is tracked and messages with `id <= lastSeenMessageId` are discarded to avoid re-capturing the full history that opencode re-sends on every message.

**Structural dedup:** every call site that writes calls `flushMessages()` after, so the next trigger finds `messages.length === 0` and skips with a debug log. No time-based guards.

**Single injection:** the startup handoff is injected only once per session. `pendingHandoff = null` after injection marks it as consumed.

## Plugin hooks

| hook | purpose |
|---|---|
| `experimental.chat.messages.transform` | injects pending handoff (once), captures user + assistant messages, writes handoff every N |
| `process.once("exit")` | auto-write on session close |
| `dispose` | cleanup (removes listener, auto-writes) |

## Notes

Less is more. :)

## Authors

- Alejandro Carraretto
- MiniMax-M3

## License

MIT — version 1.0.24
