# Auto Handoff — (tu sesión asegurada)

¿Cerraste opencode y volviste al día siguiente sin contexto? Este plugin te lo devuelve solo.

Cada N turnos guarda un snapshot de tu sesión en un `.md`. Al cerrar, guarda otro. Al abrir, lee los más recientes y los inyecta en el system prompt como contexto. Sin comandos, sin palabras clave, sin base de datos — solo archivos de texto que podés leer, versionar o borrar.

## ¿Qué hace?

- **Guardado periódico** — escribe un handoff cada N mensajes totales (user + assistant, default: 20)
- **Guardado al salir** — escribe un handoff cuando opencode cierra
- **Carga al iniciar** — lee los últimos handoffs al cargar el plugin y los inyecta en el system prompt (no como mensaje del usuario)

Cero palabras clave. Snapshots automáticos + resumen automático.

## Instalación

```bash
cp auto-handoff.ts ~/.config/opencode/plugins/
```

El plugin se carga solo al iniciar opencode. No requiere registro manual.

## Configuración

Archivo: `~/.config/opencode/auto-handoff.json`

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

| campo | default | qué hace |
|---|---|---|
| `every_turns` | `20` | guarda un handoff cada N mensajes (user + assistant). `0` = nunca periódico, solo dispose/exit |
| `on_exit` | `true` | guarda al cerrar la sesión |
| `on_start` | `true` | lee los últimos handoffs al iniciar |
| `keep_last` | `20` | cuántos mensajes recientes incluye cada handoff (mínimo 1) |
| `max_stored_files` | `10` | máximo de archivos `.md` retenidos en `.handoff/` (rotación automática, mínimo 1) |
| `max_load_files` | `3` | cuántos handoffs recientes se cargan al iniciar (mínimo 1) |
| `log_level` | `"info"` | nivel de log (`silent`, `info`, `debug`) |

Si el archivo no existe, se usan los defaults.

## Verificación

```bash
ls ~/.config/opencode/plugins/auto-handoff.ts
```

Debería existir el archivo.

```bash
ls .handoff/
```

Después de usar opencode un rato, deberían aparecer archivos `*.md` (uno por cada handoff guardado).

```bash
tail -f ~/.config/opencode/auto-handoff.log
```

Deberías ver entradas como `Handoff written (periodic|exit|dispose): ...`, `Handoff loaded: ...`, y `Handoff injected into system prompt`.

## Formato de salida

Cada handoff es un `.md` en `.handoff/<timestamp>.md`:

```markdown
# Handoff — 2026-07-03-1430

## Reason
periodic (20 messages)

## Task
- [user] implementar dedup por ID en auto-handoff

## Decisions
- [user] usar prefijo de rol en las notes
- [assistant] usar patch-only porque solo revisiones leves

## Next steps
- [user] verificar que el dedup funciona en sesión real
- [assistant] actualizar AGENTS.md con la nueva convención

## Recent messages (last 20)
- [user] hola
- [assistant] hola. sesión cargada...
- ...
```

Las secciones `## Task`, `## Decisions` y `## Next steps` se extraen automáticamente de los mensajes (user + assistant) que contengan esos headers con bullet lists. Cada bullet lleva prefijo `[user]` o `[assistant]` para marcar su origen. Las secciones se omiten cuando están vacías.

## Cómo funciona

| trigger | cuándo | acción |
|---|---|---|
| `every_turns` | contador de mensajes (user + assistant) llega a N | escribe `.handoff/<ts>.md` |
| `dispose` hook | cierre limpio | escribe handoff (si `on_exit: true`) |
| `process.once("exit")` | fin de sesión | escribe handoff (guard de 5s evita doble escritura) |
| `on_start` | carga del plugin | lee los últimos `.handoff/<ts>.md` y los inyecta como system prompt |

**Separación contexto/turnos:** el handoff se inyecta como system prompt, no como mensaje del usuario. Esto evita que el template de resume se propague al siguiente handoff (contaminación del buffer).

**Buffer con tagging:** los mensajes en memoria tienen role `user` o `assistant`. Solo el mensaje sintético de resume (`handoff-resume`) se excluye del buffer.

**Deduplicación:** si un mensaje es idéntico al último del buffer, se descarta. Además, se trackea el último `message.id` visto y se descartan mensajes con `id <= lastSeenMessageId` para evitar re-capturar el historial completo que opencode re-envía en cada turno.

**Notas explícitas:** los headers `## Task`, `## Decisions` y `## Next steps` dentro de cualquier mensaje se extraen como bullets con prefijo de rol (`[user]` / `[assistant]`). Se deduplican por `(role, text)` y se limpian en cada escritura. Esto permite que vos (o el assistant) registren intención, decisiones y próximos pasos que sobreviven al handoff.

**Doble escritura:** `dispose` y `process.exit` pueden dispararse juntos. Un guard de 5 segundos evita que se escriban dos handoffs con el mismo contenido.

**Inyección única:** el handoff de inicio se inyecta una sola vez por sesión (en el primer `system.transform`).

## Hooks del plugin

| hook | propósito |
|---|---|
| `experimental.chat.system.transform` | inyecta handoff pendiente como system prompt en la primera llamada |
| `experimental.chat.messages.transform` | captura mensajes user + assistant, escribe handoff cada N |
| `process.once("exit")` | auto-escritura al cerrar sesión |
| `dispose` | cleanup (remueve listener, auto-escribe) |

## Notas

- Menos es más. :)

## Autores

- Alejandro Carraretto
- MiniMax-M3

## Licencia

MIT — versión 1.1.0
