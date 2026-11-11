# Hoja de ruta

Ideas ordenadas aproximadamente por valor. Lo marcado con ✅ ya está hecho. Las propuestas nuevas son
bienvenidas como *issues*.

## Reproducción
- [ ] **Canales de YouTube (vídeos, no directos):** añadir un canal por `@usuario`; sus últimos vídeos salen del RSS
  público (`youtube.com/feeds/videos.xml?channel_id=…`) y se reproducen con el reproductor incrustado. Sin
  subtítulos de Whisper (el audio no pasa por el proxy).
- [ ] Selector de resolución (niveles de hls.js), audio alternativo y subtítulos del propio stream.
- [ ] Indicador de *buffering*, panel de estadísticas y botón «volver al directo».
- [ ] Forzar IPv4 por canal propio (algunas CDN cortan IPv6).
- [ ] Metadatos ICY («está sonando…») de las emisoras que los emiten.
- [ ] Arrastrar un canal de la lista a una casilla concreta del mosaico.

## Ventana y reproductor
- [ ] **Ventana propia** en lugar de abrir el navegador: modo app de Chrome/Edge (sin dependencias) con un ajuste para
  elegir; cerrar la ventana podría parar el servidor y sustituir al botón «Salir». pywebview, más adelante y opcional.
  Hay una **aplicación con Chromium propio (Electron) y plugins**, con el puente de Atresplayer como primer plugin, que
  los instaladores llevan desde la 1.3.0 ([docs/DESKTOP.md](docs/DESKTOP.md)). Lo que falta: actualizaciones y firma de
  código; es la base de código principal, el modo navegador se mantiene.
- [ ] **Plugins abiertos y acceso para IAs (un MCP):** hechos (sin publicar) los plugins de desarrollo, el bus de control, el
  servidor MCP y los **plugins con permisos** (panel aislado, SDK, empaquetar e instalar `.tdtplugin`:
  [docs/HACER-PLUGINS.md](docs/HACER-PLUGINS.md)). Hecho: instalar desde un enlace y desde un catálogo con el hash fijado. Hechas también las firmas de autor. Falta: que una IA escriba
  plugins con permisos por el MCP, plugins de datos y de servicio, y las marcas de anuncios como evento. Diseño en
  [docs/PLUGINS.md](docs/PLUGINS.md).
- [ ] **Hacer la aplicación «hackeable»** (que cualquiera pueda cambiarla a su gusto, sin esfuerzo): una escalera de ajustes ▸ reglas sin código ▸
  plugins con permisos ▸ plugins de desarrollo, con la IA como rampa de entrada. Hecho (sin publicar): **las reglas** («cuando pase esto,
  haz aquello», [docs/REGLAS.md](docs/REGLAS.md)), por el botón *Reglas* y por MCP. Hecho también: el **modo seguro** (arrancar sin plugins), los **límites de memoria y procesador por plugin**, las **firmas de autor**, el **catálogo y la instalación por enlace**, el **inspector en vivo** de eventos y llamadas, los **temas de plugin** (solo colores, los elige el usuario), las **reglas y atajos que trae un plugin** (apagados hasta que el usuario los enciende), los **proveedores de canales y de guía** (`tdt.channels.provide`, `tdt.epg.provide`), los **ajustes generados desde el manifest** (`tdt.settings`) y una **lista única de órdenes y eventos**
  (`static/commands.json`) a la que se ajustan reglas, plugins, bus y MCP, y un **bus de eventos** (`channel.changed`, `kind.changed`,
  `volume.changed`, `programme.started`) para plugins y por MCP. Hecho también, primer hito de [docs/HACKEABLE.md](docs/HACKEABLE.md): los **ganchos** (acciones, filtros y registros con prioridad, en la página y en el servidor), el cargador de plugins con todo el poder y la **publicidad como plugin incluido** (eventos `ad.started` y `ad.ended`, filtro `ad.reaction`, registro `ad.actions`). Hecho también: **plugins con todo el poder que cualquiera instala** (`tdt.full`, sin el modo desarrollador, con la aprobación atada a la huella del código). Hechos también: las **capas sobre la imagen** (`tile.overlay`) y los **temas completos** (hoja de estilo, `docs/TEMAS.md`). Falta, en este orden: la parte de servidor y el alcance `main` de esos plugins; las demás ranuras de interfaz, las plantillas y los temas hijo y temas completos; el registro de reproductores; el evento `channel.status`; ajustes
  los servicios con Workers y notificaciones del sistema (los servicios que duermen hasta su evento o su hora ya están hechos); puntos de enganche en la interfaz (botones, menú, superposición, temas); un inspector en vivo; catálogo e instalación por
  enlace. Plan y estado en [docs/PLUGINS-ARQUITECTURA.md](docs/PLUGINS-ARQUITECTURA.md#14-hackeable-la-escalera).
- [ ] **Fuentes de reproducción como plugins** (YouTube, Twitch, el reproductor de Atresplayer; hecho el mecanismo declarativo `tdt.sources` con el
  permiso `embed:servidor`, comprobado con un directo de Twitch: arranca con un clic. YouTube y Atresplayer **no se mueven todavía**: harían falta adaptadores
  de control del sonido y el modo navegador no tiene plugins; análisis en [docs/PLUGINS-ARQUITECTURA.md](docs/PLUGINS-ARQUITECTURA.md)): salen del núcleo y cada una pasa a ser un
  plugin que declara el servidor al que se conecta y que el usuario aprueba, para que el núcleo no cargue código de terceros. Falta un
  permiso para embeber un servidor y poder ser una fuente de canal; si Twitch acepta su reproductor en la caja de un plugin está por
  comprobar. Diseño en [docs/PLUGINS.md](docs/PLUGINS.md). Un PR de Twitch en el núcleo queda abierto como referencia.
- [ ] **Reproductor ampliable con plugins:** cada casilla como una cadena (audio, vídeo, capas) con módulos que declaran
  sus ajustes. El sonido y la reacción a las pausas de anuncios serían los primeros.
- [ ] **Sustituir los anuncios por otro contenido** (otro stream, vídeo o imagen), reescribiendo la lista entre
  `cue-out` y `cue-in` en el proxy.
- [ ] **Modo compatible con ffmpeg:** reempaquetar o transcodificar los canales con códecs o formatos que el navegador
  no reproduce (MPEG-2, AC-3, TS crudo), solo en los canales que lo necesiten. mpegts.js como paso intermedio.
- [x] Igualador de volumen y ecualizador, globales o por canal.
- [x] Reacción a las pausas de anuncios (silenciar, bajar el sonido, cambiar de canal, mostrar una web).
- [x] Marcas de anuncios SCTE-35: detección, registro y exportación.

## Guía de programación
- [ ] Unos 33 IDs de tele y unos 210 de radio de las listas no están en el XMLTV (locales, `OC_*` de Onda
  Cero…): otra fuente o una tabla de equivalencias.
- [ ] Recordatorios: avisar cuando empiece un programa marcado (notificación del navegador).
- [ ] Buscar en la guía («qué ponen esta noche de…») a través de todos los canales.
- [ ] Refrescar la guía abierta cuando acaba el programa en curso.

## IA local
- [ ] **Contexto online:** de lo que se dice (transcripción o guía) sacar 1–3 consultas con el modelo y listar
  titulares de medios (RSS de noticias), agrupados por medio.
- [ ] **Rotación inteligente:** priorizar la casilla cuyo programa o transcripción encaja con temas del usuario.
- [ ] **«Qué ver hoy»:** agenda con favoritos e historial local.
- [ ] Emparejar con IA los canales sin EPG con los del XMLTV (script puntual).
- [ ] Transcripción: solapar 1–2 s entre segmentos, soportar fMP4/CMAF (guardar el segmento `EXT-X-MAP`) y VAD.
- [ ] Transcripción de radio continua: retrasar el audio unos segundos para que los subtítulos salgan sincronizados.
- [ ] Parar `whisper-server` aunque el servidor muera a la fuerza (objeto *Job* de Windows).

## Cuenta y preferencias
- [ ] Descargar también el programa `whisper-server` (binarios de whisper.cpp) desde Ajustes.
- [ ] Elegir el mensaje del sistema del asistente y exportar/importar los ajustes.
- [ ] Favoritos y preferencias en el servidor (`data/prefs.json`): hoy están en `localStorage`, que va por
  origen y se pierde al cambiar de puerto o usar `--lan`.
- [ ] Reordenar favoritos y numeración propia (hoy el número es la posición en la vista filtrada).
- [ ] PWA para tablet y móvil (`manifest.json` e icono).

## Robustez y seguridad
- [ ] Limitar la lista de hosts permitidos por canal (hoy crece con cada redirección o segmento validado).
- [ ] Cerrar la ventana de DNS rebinding en `Net.check_url` (conectar a la IP ya validada).
- [ ] Autenticación opcional para `--lan` (`--token`).
- [ ] Historial de salud: guardar los últimos N resultados por fuente y priorizar la más estable.
- [ ] Caché corto (~30 s) de segmentos en el proxy para varios clientes en la LAN.
- [ ] Limpiar la caché de logos (`data/logos/`): borrar los de canales que ya no están y caducar los `.fail`.
- [ ] Mostrar o descartar las URL con macros sin rellenar (`[IP]`, `[UA]`).

## Distribución
- [ ] Firmar los instaladores (Authenticode en Windows; Developer ID y notarización en macOS).
- [ ] winget, Homebrew cask y un repositorio APT / Flatpak.
- [ ] Instalador de Windows para ARM y paquete `.rpm`.
- [ ] Icono en la bandeja del sistema en lugar del botón «Salir».

## Calidad
- [ ] Comprobación de tipos con `mypy` en la CI (las anotaciones ya están; falta ejecutarlo y arreglar lo que salga).
- [ ] Medir la cobertura de las pruebas y subir la de `stt.py` (hilos y procesos).
- [ ] Pruebas de interfaz con un navegador sin cabeza.
- [x] Pruebas de Python y del navegador, lint y CI.
- [x] Paquete instalable sin estado global.
