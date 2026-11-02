# TDT local en Omarchy

Integración de TDT local con un escritorio [Omarchy](https://omarchy.org/) (Arch + Hyprland + Quickshell): control desde la
barra, el menú y los agentes de IA, con **mpv** como reproductor. Probado en Omarchy con Hyprland; la CLI y la unidad de
systemd sirven en cualquier Linux, el widget y el menú son solo de Omarchy.

| Pieza | Qué es | ¿Solo Omarchy? |
|---|---|---|
| [`scripts/tdtv.py`](../../scripts/tdtv.py) | CLI `tdtv`: poner canales y radios, guía, volumen, zapping, efectos (mpv), teletexto. Salida `--json`. | No: cualquier Linux con mpv |
| [`tdt-local.service`](tdt-local.service) | Servicio de usuario de systemd para el servidor | No |
| [`plugin/tdtlocal.tdtv/`](plugin/tdtlocal.tdtv) | Widget de la barra (Quickshell): canal y programa, pausa, volumen, zapping | Sí |
| [`menu.jsonc`](menu.jsonc) | Submenú «TDT» del menú de Omarchy | Sí |
| [`skill/SKILL.md`](skill/SKILL.md) | Skill para agentes de IA (Claude Code, Codex, Gemini…): «pon La 1», «qué hay en la tele», «lee el teletexto» | No |

## Instalar

```
# 1. El servidor como servicio (ajusta WorkingDirectory al código)
cp contrib/omarchy/tdt-local.service ~/.config/systemd/user/ && systemctl --user enable --now tdt-local

# 2. La CLI en el PATH (necesita mpv; en Omarchy ya viene mpv-mpris, que anuncia el reproductor al escritorio)
ln -s "$PWD/scripts/tdtv.py" ~/.local/bin/tdtv
tdtv now && tdtv play "la 1"

# 3. El widget y el menú de Omarchy
cp -r contrib/omarchy/plugin/tdtlocal.tdtv ~/.config/omarchy/plugins/
omarchy plugin enable tdtlocal.tdtv
#    el menú: copia las entradas de menu.jsonc dentro de ~/.config/omarchy/extensions/omarchy-menu.jsonc

# 4. Para los agentes: enlaza la skill en el directorio de skills de cada uno, p. ej. Claude Code
mkdir -p ~/.claude/skills/tdtv && cp contrib/omarchy/skill/SKILL.md ~/.claude/skills/tdtv/
```

El widget: clic izquierdo pausa o reanuda (o abre la app si no suena nada), clic derecho abre la app, clic central para,
la rueda cambia el volumen y Ctrl+rueda cambia de canal.

## Cómo funciona

- `tdtv` pide `/api/channels` y `/api/epg` al servidor, lanza **mpv** con la fuente del canal (por el proxy de TDT local si el
  canal lleva cabeceras) y lo gobierna por su socket IPC (`$XDG_RUNTIME_DIR/tdtv/`). El estado que ven el widget y los
  agentes sale de mpv, no de la página web.
- `tdtv fx` aplica los **efectos de imagen** (los mismos ficheros GLSL de `tdtlocal/static/fx/`, que son shaders de mpv) y sus
  filtros de audio en caliente. `tdtv ttx` abre la app en una página del **teletexto** o la lee como texto.
- En Omarchy, `tdtv web` y `tdtv ttx N` abren la app como ventana (`omarchy launch webapp`) y, si ya había una, la cierran antes
  para que la nueva caiga en el enlace pedido. Con otros escritorios usa `xdg-open` o la orden de `TDTV_OPEN` (con `{url}`).
- Variables: `TDTV_URL` (servidor), `TDTV_MPV_ARGS` (opciones de mpv), `TDTV_FX_DIR` (efectos), `TDTV_OPEN`.

## Límites

- Atresmedia y Mediaset no tienen directo en las listas: solo en la app web.
- Los efectos y el teletexto dependen de versiones de TDT local que los incluyan (`tdtv` lo dice si faltan).
- El widget no se ha probado en versiones de Omarchy distintas de la actual; su API de plugins puede cambiar.
