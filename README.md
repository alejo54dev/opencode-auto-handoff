# Auto Handoff — (tu sesión asegurada)

¿Cerraste opencode y volviste al día siguiente sin contexto? Este plugin te lo devuelve solo.

Cada 10 turnos guarda un snapshot de tu sesión en un `.md`. Al cerrar, guarda otro. Al abrir, lee el más reciente y lo inyecta en el contexto como si nunca te hubieras ido. Sin comandos, sin palabras clave, sin base de datos — solo archivos de texto que podés leer, versionar, o borrar.

## ¿Qué hace?

- **Guardado periódico** — escribe un handoff cada N turnos del usuario (default: 10)
- **Guardado al salir** — escribe un handoff cuando opencode cierra
- **Carga al iniciar** — lee el último handoff al cargar el plugin y lo inyecta en el contexto como mensaje sintético del usuario

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
	"every_n_turns": 10,
	"on_exit": true,
	"on_start": true,
	"recent_messages_count": 10,
	"log_level": "info"
}
```

| campo | default | qué hace |
|---|---|---|
| `every_n_turns` | `10` | guarda un handoff cada N turnos del usuario |
| `on_exit` | `true` | guarda al cerrar la sesión |
| `on_start` | `true` | lee el último handoff al iniciar |
| `recent_messages_count` | `10` | cuántos mensajes recientes incluye cada handoff |
| `log_level` | `"info"` | nivel de log (`debug`, `info`, `warn`, `error`) |

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

Deberías ver entradas como `Handoff written (periodic|exit|dispose): ...` y `Handoff loaded: ...`.

## Formato de salida

Cada handoff es un `.md` en `.handoff/<timestamp>.md`:

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

## Cómo funciona

| trigger | cuándo | acción |
|---|---|---|
| `every_n_turns` | contador de turnos llega a N | escribe `.handoff/<ts>.md` |
| `dispose` hook | cierre limpio | escribe handoff (si `on_exit: true`) |
| `process.once("exit")` | fin de sesión | escribe handoff (guard de 5s evita doble escritura) |
| `on_start` | carga del plugin | lee el último `.handoff/<ts>.md` y lo inyecta como mensaje sintético |

**Deduplicación:** si un mensaje es idéntico al último del buffer, se descarta.

**Doble escritura:** `dispose` y `process.exit` pueden dispararse juntos. Un guard de 5 segundos evita que se escriban dos handoffs con el mismo contenido.

**Inyección única:** el handoff de inicio se inyecta una sola vez por sesión (en el primer `messages.transform`).

## Hooks del plugin

| hook | propósito |
|---|---|
| `experimental.chat.messages.transform` | cuenta turnos del usuario, escribe handoff cada N, inyecta handoff pendiente en la primera llamada |
| `process.once("exit")` | auto-escritura al cerrar sesión |
| `dispose` | cleanup (remueve listener, auto-escribe) |

## Notas

- Menos es más. :)

## Autores

- Alejandro Carraretto
- MiniMax-M3

## Licencia

MIT — versión 1.0.5
