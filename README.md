# Auto Handoff — (your session is safe)

![Version](https://img.shields.io/badge/version-1.1.2-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![OpenCode](https://img.shields.io/badge/OpenCode-plugin-purple)

> You close OpenCode, come back the next day and all context is gone? You have to re-explain everything from scratch? Not anymore!

## 💡 What it does

> Close OpenCode without losing the thread.

- **Auto save** — every N messages dumps to a .md file. Plain text, readable, versionable.

- **Auto resurrection** — close saves, open reads. Everything is back where you left it.

- **No commands, no DB** — just .md files you can read, delete, or push to git.

## 🧠 Philosophy

The handoff speaks the same language as the model. What the model writes, another model reads. No translation, no loss.

On load, it recovers only the conversation — no headers, no metadata, no junk. Just pure chat back into context.

## 🔄 How it works

```mermaid
flowchart TD
    A["🔌 Plugin loads"]
    A --> B{"on_start?"}
    B -->|"✅ Yes"| C["📂 Read .md files<br/>→ pendingHandoff"]
    B -->|"❌ No"| D["📝 Messages flow"]
    C --> D

    D --> E{"pendingHandoff?"}
    E -->|"✅ Yes"| F["📎 Inject &lt;handoff-resume&gt;<br/>→ flush buffer"]
    E -->|"❌ No"| G["📥 Capture messages"]
    F --> G

    G --> H{"Counter >=<br/>every_messages?"}
    H -->|"✅ Yes"| I["💾 Save handoff .md<br/>→ flush buffer"]
    H -.->|"❌ No"| D
    I -.-> D

    J["🛑 exit / dispose"]
    J --> K{"on_exit?"}
    K -->|"✅ Yes"| L["💾 Save handoff<br/>→ flush"]
    K -->|"❌ No"| M["🧹 Cleanup"]
    L --> M

    style A fill:#1a1a2e,stroke:#e94560,color:#fff
    style B fill:#16213e,stroke:#e94560,color:#fff
    style C fill:#0f3460,stroke:#53a8b6,color:#fff
    style D fill:#1a1a2e,stroke:#e94560,color:#fff
    style E fill:#16213e,stroke:#e94560,color:#fff
    style F fill:#0f3460,stroke:#53a8b6,color:#fff
    style G fill:#1a1a2e,stroke:#e94560,color:#fff
    style H fill:#16213e,stroke:#e94560,color:#fff
    style I fill:#0f3460,stroke:#53a8b6,color:#fff
    style J fill:#1a1a2e,stroke:#e94560,color:#fff
    style K fill:#16213e,stroke:#e94560,color:#fff
    style L fill:#0f3460,stroke:#53a8b6,color:#fff
    style M fill:#1a1a2e,stroke:#e94560,color:#fff
```

| Trigger | When | Action |
|---|---|---|
| `every_messages` | message counter (user + assistant) reaches N | writes `.handoff/<ts>.md` |
| `dispose` hook | clean shutdown | reads latest messages via API and saves (if `on_exit: true`) |
| `process.once("exit")` | session ends | saves whatever was captured so far |
| `on_start` | plugin load | reads latest `.handoff/<ts>.md` files, extracts full messages via `parseFeedback()`, stores as `pendingHandoff` |

## 🚀 Installation

```bash
cp auto-handoff.ts ~/.config/opencode/plugins/
```

The plugin loads automatically when OpenCode starts. No manual registration required.

## ⚙️ Configuration

Copy `auto-handoff.jsonc` (included in this repo) to `~/.config/opencode/` and edit:

```jsonc
{
	"every_messages": 20,   // trigger periodic write every N messages (0 = never)
	"on_exit": true,        // write handoff on dispose/exit
	"on_start": true,       // load recent handoffs on startup
	"keep_last": 20,        // max messages per handoff (write & load)
	"max_stored_files": 10, // max .handoff/*.md files to keep (rotation)
	"max_load_files": 5,    // max recent handoff files to load on startup
	"log_level": "info"     // silent, error, info, debug
}
```

| Field | Default | Description |
|---|---|---|
| `every_messages` | `20` | trigger periodic write every N messages (user + assistant). `0` = never periodic, only dispose/exit |
| `on_exit` | `true` | write handoff on dispose/exit |
| `on_start` | `true` | load recent handoffs on startup |
| `keep_last` | `20` | max messages per handoff (write & load, minimum 1) |
| `max_stored_files` | `10` | max `.handoff/*.md` files to keep (rotation, minimum 1) |
| `max_load_files` | `5` | max recent handoff files to load on startup (minimum 1) |
| `log_level` | `"info"` | log level (`silent`, `error`, `info`, `debug`) |

If the file doesn't exist, defaults are used.

## 🪵 Logs

`~/.config/opencode/auto-handoff.log` (append-only). Format: `[TIMESTAMP] [LEVEL] message`.

```bash
tail -f ~/.config/opencode/auto-handoff.log
```

```log
[2026-07-05T10:30:00] [INFO]: Config loaded
[2026-07-05T10:30:01] [INFO]: Initialized | project: /home/user/myapp
[2026-07-05T10:35:12] [INFO]: Handoff written: periodic (21 messages): .handoff/2026-07-05-1035.md
[2026-07-05T10:40:23] [INFO]: Handoff loaded: 3 file(s), 15 messages
[2026-07-05T10:41:00] [INFO]: Handoff injected: 15 messages, 2875 bytes
[2026-07-05T10:50:00] [INFO]: Handoff written: exit (10 messages): .handoff/2026-07-05-1050.md
[2026-07-05T10:50:01] [INFO]: Disposed
[2026-07-05T11:00:00] [DEBUG]: Handoff skipped (no messages): exit
```

## 📝 Output format

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

## 🔌 Plugin hooks

| Hook | Purpose |
|---|---|
| `experimental.chat.messages.transform` | injects pending handoff (once), captures user + assistant messages, writes handoff every N |
| `process.once("exit")` | saves on session close |
| `dispose` | reads latest via API and saves when closing |

## 💬 Notes

Less is more. :)

## 👤 Authors

- Alejandro Carraretto
- MiniMax-M3

## 📄 License

MIT — version 1.1.2
