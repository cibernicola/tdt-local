---
name: tdtv
description: Controla la TDT, la radio y el teletexto españoles en el equipo del usuario con TDT local (mpv + la CLI tdtv). Úsala cuando pida poner un canal o una emisora, pausar, cambiar el volumen o de canal, parar, saber qué hay en la tele ahora o después (guía), aplicar efectos de imagen (matrix, ascii, canal+, cyberpunk, vhs, crt…), abrir el teletexto o leer sus noticias, tiempo o deportes.
---

# tdtv: tele, radio y teletexto con TDT local

Todo se hace con la CLI `tdtv` (`scripts/tdtv.py` de TDT local, instalada como `tdtv` en el PATH). Añade `--json` para una salida estructurada.
Detrás hay el servidor de TDT local (`127.0.0.1:8788`: listas, guía, teletexto) y mpv como reproductor.

## Órdenes
| Quiero… | Orden |
|---|---|
| Qué hay ahora en la tele | `tdtv now` · `tdtv now "cuatro" "la 2"` |
| Poner un canal o una radio | `tdtv play "la 1"` · `tdtv play "radio nacional"` (nombre aproximado) |
| Qué suena | `tdtv status` |
| Pausa, volumen, canal | `tdtv pause` · `resume` · `toggle` · `mute` · `vol 50` · `vol +5` · `next` · `prev` · `stop` |
| Buscar canales | `tdtv list --q antena` · `tdtv cats` |
| Otra fuente si un canal no carga | `tdtv play "canal" --source 1` |
| Efectos de imagen (mpv) | `tdtv fx list` · `tdtv fx matrix` · `tdtv fx matrix vhs` (combinar) · `tdtv fx toggle crt` · `tdtv fx off` |
| Teletexto en la app | `tdtv ttx 101` (abre la app en esa página) |
| Leer el teletexto | `tdtv ttx 101 --text` o `--json` (`--sub N` para subpáginas) |
| Abrir la app de TDT local | `tdtv web` |

## Reglas
- **Leer** (`now`, `status`, `list`, `ttx --text`) siempre se puede. **Controlar** (poner o parar canales, volumen, efectos, abrir ventanas) cambia lo que el usuario ve y oye: hazlo solo si lo ha pedido.
- Si `play` sale con código 3 y una lista de candidatos, pregunta cuál; no adivines.
- Contesta con lo que devolvió `tdtv`. **No inventes programación ni titulares**; en el teletexto cita la fuente (EL PAÍS, EL MUNDO, Europa Press, Open-Meteo) y la hora de actualización (`updated`).
- El teletexto y los efectos de imagen existen solo si esa versión de TDT local los incluye; el teletexto, además, está desactivado hasta que el usuario lo activa en Ajustes ▸ Listas y guía.
- Atresmedia (Antena 3, laSexta…) y Mediaset no tienen directo en las listas: solo se ven en la app web.
- Los canales marcados GEO pueden fallar fuera de España y los enlaces caducan: prueba otra `--source` antes de decir que no funciona.
- Es un servicio local sin autenticación: no lo expongas a la red (`--lan`).
