# Puntos de enganche del núcleo (inventario)

> Anexo de [HACKEABLE.md](HACKEABLE.md), que es la visión y el plan vigentes. Este documento es el mapa de **dónde decide hoy el núcleo**. Las partes que hablan de aislamiento (§10) valen para el «modo ligero»; los plugins
> con todo el poder no pasan por mensajes.

Para qué sirve: una aplicación es hackeable cuando **el núcleo no decide a solas**, sino que cada decisión pasa por un punto donde otros pueden mirar, cambiar o reemplazar. Este documento apunta **dónde decide hoy el núcleo** y qué enganche
le haría falta. No hay código nuevo: es el mapa antes de tocar nada.

Vocabulario (la idea de WordPress, sin copiarlo):

- **Acción**: «ha pasado esto». Los demás reaccionan; no cambian lo que pasó. Ya existen como *eventos*.
- **Filtro**: un valor pasa por una cadena y cada eslabón puede cambiarlo antes de que el núcleo lo use («¿qué reproductor?», «¿qué hago ante este corte?»). **No existen todavía.**
- **Ranura**: un sitio de la pantalla que el núcleo reserva y otros llenan.
- **Registro**: una lista de cosas que el núcleo trata igual vengan de donde vengan (reproductores, acciones). Lo integrado es la primera entrada.

Regla de oro: **lo que el núcleo hace por defecto es el primer eslabón de la cadena**, no un `if` aparte. Si el núcleo no se engancha a sí mismo, nadie puede reemplazarlo.

## 1. Lo que ya es enganche

| Qué | Dónde | Tipo |
|---|---|---|
| Eventos `channel.changed`, `kind.changed`, `volume.changed`, `programme.started` | `js/events.js` | acción |
| Órdenes (`play`, `kind`, `volume`, `mute`, `multi`, `toast`) | `commands.json`, `control.py` | orden |
| Reglas por hora, canal, programa y tecla | `rules.py`, `js/rules.js` | acción → orden |
| Fuentes declarativas (`tdt.sources`) | `js/sources.js` | registro (solo «mostrar esta web») |
| Proveedores de canales y de guía | `providers.py` | registro (datos) |
| Ajustes generados, temas, activación por servicios | `plugin-host.js` | ranura de configuración |
| Paneles de plugin: `float` y `screen` | `plugin-host.js` | ranura (solo dos, de un tamaño) |

Lo que falta es lo de abajo.

## 2. Reproducir

**Hoy decide `Tile.attempt` (`js/tile.js`, ~512–528):** una cadena de `if` ordenada a mano.

```
parseU7d → attachU7d · ytEmbed → attachYoutube · atresEmbed → attachAtres · pluginEmbed → attachSourceFrame
 · Hls.isSupported() && usesHls → attachHls · si no → attachDirect
```

| Punto | Hoy | Enganche propuesto |
|---|---|---|
| Qué reproductor toca esta fuente | cadena de `if` | **registro `players`**: cada reproductor dice `match(fuente)`, `attach(tile, fuente)` y cómo se silencia/sube. Lo integrado (HLS, directo, YouTube, Atresplayer, U7D, fuente de plugin) son las primeras entradas. **Filtro `player.pick`** para forzar uno. |
| Orden y elección de fuentes de un canal | `buildPlan` (`js/lib/plan.js`) + `preferred` | **filtro `plan.sources`** |
| URL de la fuente que se pide | `'/proxy?u=…'` en `attempt` | **filtro `stream.url`** |
| Éxito, fallo, señal perdida | cierres `success`/`fail`/`lost` dentro de `attempt` | **acciones** `playback.started`, `playback.failed`, `playback.lost` (con canal y fuente) |
| Qué hacer ante «sin señal» | `showNotice(...)` fijo | **filtro `playback.failed.notice`** (texto y botones) |
| Recordar la fuente que funcionó | `host.remember` | se queda: es una decisión del núcleo, no hace falta enganche |

Difícil: un reproductor de plugin que **decodifique vídeo** necesita media del proxy dentro de un marco aislado (hoy la CSP y los encabezados CORP lo impiden). Los reproductores que son **una web con su control**
(`tdt.sources` + `control`) ya existen. Decisión pendiente: si se permite el segundo tipo.

## 3. Audio

| Punto | Hoy | Enganche |
|---|---|---|
| Volumen/silencio de una casilla | `Tile.syncAudio`, `setDuck` | acción `volume.changed` (ya) + **filtro `audio.gain`** (ganancia final de una casilla) |
| Nivelador y ecualizador | `js/audio.js`, `chainFor` | se queda; es un efecto, no una decisión |

## 4. Publicidad

**Cómo llega un corte hoy:**

```
/proxy (server.py:394) → app.scte.observe → registro de marcas → js/scte.js → initScte.react = adsEvents (adbreak.js)
  → reactionTo (lib/adbreak.js) decide «start»/«end» → schedule espera al segmento → begin()
Atresplayer: adsExternal(tile, on) (puente de su reproductor) → begin()
```

**Qué hace `begin()` / `finish()` (`js/adbreak.js`), todo fijo y gobernado por `cfg.*` de Ajustes:**

1. cartel «PUBLICIDAD» (`cfg.flag` → `tile.setAdFlag`)
2. audio: silenciar o bajar (`cfg.audio` → `tile.setDuck`)
3. pantalla (`cfg.screen`): `channel` (cambiar a otro canal o aparcarlo), `web` (`tile.showAdFrame`) o `keep`
4. aviso en pantalla (`host.say`)
5. temporizador de fin con margen; al acabar: quitar el cartel, restaurar el audio, volver al canal

| Punto | Hoy | Enganche propuesto |
|---|---|---|
| Un corte empieza / acaba | solo lo sabe `adbreak.js` | **acciones `ad.started`, `ad.ended`** (canal, tipo de marca, duración conocida o no, origen: SCTE o reproductor) |
| Marca SCTE vista | solo lo sabe `scte.js` | **acción `ad.marker`** (cruda, para quien quiera mirarla) |
| ¿Se reacciona? ¿con qué? | `cfg.*` fijo | **filtro `ad.reaction`**: recibe la reacción por defecto (una lista de acciones) y el contexto, y devuelve la que se hará |
| Qué se hace | cinco cosas fijas dentro de `begin()` | **registro `actions`**: «cartel», «bajar audio», «cambiar de canal», «mostrar web», «avisar» pasan a ser acciones normales. **Un plugin puede registrar las suyas** y las reglas y `ad.reaction` las usan. |
| Deshacer al acabar | `finish()` ad hoc | cada acción devuelve cómo se deshace; el núcleo lo llama al terminar |
| Tiempos | `END_MARGIN`, `PREROLL_CONTENT_SECONDS` | se quedan (son del núcleo), pero se **exponen** en el evento |

Con esto, «cuando haya publi, cualquier cosa» = un plugin registra una acción (una capa, un webhook, un cambio de escena, sonar una alarma…) y la pone en la reacción.

## 5. Canales y guía

| Punto | Hoy | Enganche |
|---|---|---|
| Lista final | `Store.all_channels` (`store.py:106`): `tv + u7d + radios + custom + provided`, orden fijo | **filtro `channels.list`** (añadir, quitar, reordenar, renombrar) |
| Fila de la lista | `makeRow` (`app.js`) fija | **ranura `channel.row`** (insignia/botón por canal) |
| Guía | `Epg.payload` (`epg.py:231`) junta tres fuentes y las de plugin | **filtro `guide.programmes`** |
| Logos | `logos.py` | sin enganche (poco valor) |

## 6. Red (lado servidor)

`Handler._proxy` (`server.py:357`) pone cabeceras del canal, abre, reescribe las listas y copia segmentos al transcriptor.

| Punto | Hoy | Enganche |
|---|---|---|
| Cabeceras de la petición | `store.headers_for` (editables por canal con MCP) | ya cubierto por datos; **no** conviene código de plugin en cada petición |
| Reescritura de listas | `rewrite_playlist` | sin enganche de plugin: es crítico para la seguridad (lo que pasa por el proxy) |

El servidor se queda **cerrado a código de plugin**: cada petición pasando por un marco aislado sería lenta y es la superficie de ataque. Lo que un plugin necesite del lado servidor entra como **datos** (cabeceras, listas, guía), como ya hace.

## 7. Interfaz

La casilla (`Tile`, constructor) tiene piezas fijas: vídeo, portada de radio, barra (`tile-bar`), aviso (`notice`), subtítulos (`tile-sub`), cartel de publicidad, marco de publicidad. Los plugins solo pueden poner un
panel flotante o una pantalla entera.

| Punto | Enganche propuesto |
|---|---|
| Capa sobre el vídeo de una casilla | **ranura `tile.overlay`** — **hecha** (ver [HACKEABLE.md](HACKEABLE.md) §6): varias, una por casilla, transparentes al clic salvo que pidan clics; sin permiso nuevo (el plugin ya tiene todo el poder). |
| Botones en la barra de la casilla | **ranura `tile.bar`** |
| Botones del aviso de la casilla | **ranura `tile.notice`** (ya hay lista de acciones en `showNotice`) |
| Barra superior / cabecera | **ranura `header`** |
| Teclas | `onKey` (`app.js:794`) es un `switch` fijo → **registro `keys`**: teclas de plugin con prioridad; las del núcleo, primeras entradas. Hoy solo hay *reglas* por tecla. |
| Menús y diálogos de Ajustes | ya hay `settings` generado; sin más |
| Aspecto entero | **temas** — **hechos** (hoja de estilo, ver [TEMAS.md](TEMAS.md)); faltan las plantillas (estructura) |

## 8. Voz y subtítulos

`host.spoke` → `checkAlerts` (`app.js:577`): alertas por palabra. **Acción `subtitle.line`** (texto, canal, hora) para que un plugin reaccione a lo que se dice. Sin filtro.

## 9. Lista corta de enganches nuevos (resumen)

| Nombre | Tipo | Ámbito |
|---|---|---|
| `ad.started`, `ad.ended`, `ad.marker` | acción | publicidad |
| `ad.reaction` | filtro | publicidad |
| `actions` | registro | publicidad, reglas |
| `players`, `player.pick` | registro, filtro | reproducir |
| `plan.sources`, `stream.url` | filtro | reproducir |
| `playback.started/failed/lost` | acción | reproducir |
| `tile.overlay`, `tile.bar`, `tile.notice`, `header`, `channel.row` | ranura | interfaz |
| `keys` | registro | interfaz |
| `channels.list`, `guide.programmes` | filtro | datos |
| `subtitle.line` | acción | voz |
| `audio.gain` | filtro | audio |

## 10. Lo difícil: el aislamiento (solo para plugins del modo ligero)

Un plugin del modo ligero vive en un marco aislado y todo va por mensajes (asíncronos). De ahí:

- Un **filtro** de plugin es una petición con **tiempo límite**; si no responde, vale el valor por defecto. La cadena nunca puede bloquear la aplicación.
- En **puntos calientes** (cambiar de canal, elegir reproductor) no se espera al plugin en el momento: el plugin **registra antes** («este patrón de fuente es mío») y el núcleo resuelve con lo ya registrado. Las acciones de publicidad igual: se registran al activarse, y se *ejecutan* al llegar el corte.
- Un plugin **dormido** (servicio con activación) tiene que despertarse para contestar; el tiempo de despertar cuenta contra el límite.
- Todo enganche tiene su **permiso** y aparece en el registro de llamadas del inspector.

## 11. Orden de trabajo (anterior; el vigente está en HACKEABLE.md §4)

1. **Bus de ganchos** (acción + filtro con prioridad y tiempo límite) y el **registro de acciones**. Migrar publicidad: `ad.*`, `ad.reaction`, y las cinco reacciones actuales como acciones integradas.
2. **Ranuras de interfaz** (`tile.overlay` primero).
3. **Registro de reproductores**: migrar la cadena de `attempt` sin cambiar el comportamiento (los tests de reproducción tienen que seguir igual).
4. Filtros de datos (`channels.list`, `guide.programmes`), teclas y el resto.

Criterio de «bien hecho» en cada paso: lo integrado pasa **por el mismo camino** que un plugin; se puede probar con un plugin de laboratorio que reemplaza algo integrado; los permisos y límites aplican igual.
