# TDT local

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

> [!WARNING]
> **Esto es un cacharro personal que se escapó.** Versión incipiente, hecha para mi uso y publicada porque
> varios me lo pedisteis. Está «vibecodeado» con IA, así que los bichos y los agujeros de seguridad son más
> probables que improbables. Úsalo con cariño, no lo expongas a internet y lee la
> [letra pequeña](#letra-pequeña-con-cariño). Las críticas, las *issues* y los *pull requests* son bienvenidos.

Visor web **local** para ver la TDT española y escuchar la radio en el PC sin las apps de cada
cadena. Usa las listas públicas de [TDTChannels](https://github.com/LaQuay/TDTChannels)
(`TELEVISION.md` y `RADIO.md`) y se actualiza solo. Solo biblioteca estándar de Python:
no hay nada que instalar con `pip`. El asistente de IA y los subtítulos son opcionales y usan
programas que ya tengas (un servidor llama.cpp, ffmpeg y whisper.cpp); sin ellos, todo lo demás
funciona igual.

> **In English:** a local web viewer for Spanish digital TV and radio, fed by the public
> [TDTChannels](https://github.com/LaQuay/TDTChannels) lists. Python standard library only; HLS
> playback through a local proxy, programme guide (XMLTV), 4-channel multi-view with rotating audio,
> optional local AI assistant (any OpenAI-compatible server such as llama.cpp) and live subtitles
> and voice alerts (whisper.cpp). The interface is in Spanish.

## Capturas

Hechas con la aplicación de escritorio ([docs/DESKTOP.md](docs/DESKTOP.md)); en el modo navegador es la misma interfaz sin las pestañas Plugins y Registro.

| | |
|---|---|
| ![Vista principal con la lista de canales](docs/img/principal.png) | ![U7D: canales con grabaciones de la última semana](docs/img/u7d-canales.png) |
| ![Ajustes ▸ Plugins](docs/img/plugins.png) | ![Ajustes ▸ Registro](docs/img/registro.png) |

**Efectos de imagen** (botón «Efectos», tecla `E`): los doce efectos sobre un canal de noticias en directo. Pulsa la imagen para ver el
[vídeo de demostración](docs/img/efectos.mp4) (2 min, con el audio real de cada efecto; la emisión es de RTVE y se muestra solo como ejemplo).

[![Los doce efectos de imagen: Matrix, ASCII, ASCII en color, Canal+, cyberpunk, VHS, CRT, glitch, visión nocturna, cine negro, negativo y píxel](docs/img/efectos.jpg)](docs/img/efectos.mp4)

## Características y estado

Una por línea. **✅ Hecho**: implementado y con pruebas automáticas. **🧪 Probado poco**: funciona, pero solo se ha
comprobado en condiciones simuladas o con pocos casos reales. **📋 Pendiente**: aún no existe (la
[hoja de ruta](ROADMAP.md) tiene más ideas).

| Característica | Estado |
|---|---|
| Listas de TDTChannels al día (cada 6 h, con ETag) | ✅ Hecho |
| Reproducción de directos HLS con proxy local | ✅ Hecho |
| Radio (unas 980 emisoras, con su logo en lugar de vídeo) | ✅ Hecho |
| Comprobar qué canales y emisoras responden | ✅ Hecho |
| Multivisión de cuatro canales con audio rotativo | ✅ Hecho |
| Guía de programación (EPG) | ✅ Hecho · cubre unos 175 canales de tele y 50 emisoras |
| Directos de YouTube incrustados | ✅ Hecho |
| Canales propios, con cabeceras `Origin` y `Referer` | ✅ Hecho |
| U7D: lo emitido en los últimos 7 días por La 1, La 2, 24 Horas, Teledeporte y Clan (RTVE), del más reciente al más antiguo | 🧪 Probado poco · con la red real: la lista y la reproducción de un telediario; los programas con DRM se avisan y no se reproducen |
| U7D de Atresmedia (Antena 3, laSexta, Neox, Nova, Mega y Atreseries), solo en la aplicación de escritorio y con el plugin `atresplayer-u7d` | 🧪 Probado poco · con la red real en Antena 3: la ventana lee la lista y la grabación se abre en su página; con el DNS de esta máquina (filtra anuncios) la página no reproduce, así que la reproducción no está comprobada |
| Favoritos, último canal, volumen y filtros (en el navegador) | ✅ Hecho |
| Ajustes desde la interfaz, sin reiniciar | ✅ Hecho |
| Modo navegador: el servidor sin consola y tu navegador, con el botón «Salir» (`--classic` en la construcción, o `python -m tdtlocal`) | ✅ Hecho |
| Aplicación de escritorio con ventana propia (Electrón), bandeja, plugins y Registro | 🧪 Probado poco · los instaladores la llevan desde la 1.3.0; la CI prueba que arranca, sirve la página y se cierra, pero no se ha visto en máquinas limpias de macOS y Linux; sin actualizaciones automáticas |
| Asistente de IA local (órdenes y preguntas) | ✅ Hecho · necesita un servidor compatible con OpenAI |
| Subtítulos en directo con Whisper | 🧪 Probado poco · alucina con música y voces solapadas |
| Alertas por voz (palabras vigiladas en las cuatro casillas) | 🧪 Probado poco · misma limitación |
| Instaladores para Windows, macOS (13 o superior) y Linux | 🧪 Probado poco · sin firmar; pesan unos 100 MB; macOS y Linux sin probar en máquinas limpias |
| Efectos de imagen en el reproductor (Matrix, ASCII, Canal+ codificado, cyberpunk, VHS, CRT…): doce shaders GLSL que se aplican al canal activo con WebGL 2 | 🧪 Probado poco · los doce compilan y se ven bien con una imagen de prueba; no se han visto con vídeo en directo en la interfaz |
| Marcas de anuncios SCTE-35 en las listas HLS: detectar, decodificar, guardar y exportar (JSON y CSV) | ✅ Hecho · comprobado con streams reales |
| Aviso en pantalla cuando aparece una marca nueva | ✅ Hecho |
| Marcas SCTE-35 dentro del vídeo (PID del MPEG-TS, eventos `emsg`) | 🧪 Probado poco · solo con datos sintéticos |
| Durante la publicidad: silenciar o bajar el sonido | 🧪 Probado poco · con un directo simulado |
| Durante la publicidad: cambiar a otro canal y volver | 🧪 Probado poco · con un directo simulado |
| Durante la publicidad: mostrar una web sobre la imagen, con comprobación previa | 🧪 Probado poco · con un directo simulado |
| Durante la publicidad: respetar o deshacer lo que toques | 🧪 Probado poco · con un directo simulado |
| Igualador de volumen (sube lo bajo y baja lo alto hasta un nivel) | 🧪 Probado poco · con señales sintéticas |
| Ecualizador de diez bandas con preajustes | 🧪 Probado poco · con señales sintéticas |
| Ajustes de sonido globales y propios de cada canal | ✅ Hecho |
| Atresmedia con un clic (Antena 3, La Sexta, Neox, Nova, Mega, Atreseries) con el reproductor oficial de Atresplayer incrustado | 🧪 Probado poco · se ha visto emitir La Sexta; los otros cinco cargan su reproductor |
| Aviso fijo «PUBLICIDAD» sobre la imagen mientras dura una pausa (con stream, o con el puente en Atresplayer) | 🧪 Probado poco · con un directo simulado y con mensajes simulados del puente |
| Igualador de volumen y ecualizador también en el reproductor de Atresplayer (con el puente como extensión) | 🧪 Probado poco · con un audio de prueba dentro de un iframe, no con el reproductor real ni como extensión cargada |
| Puente con el reproductor de Atresplayer (`tools/puente-atresplayer`): leer su aviso «Publicidad» y silenciarlo | 🧪 Probado poco · la detección, con el reproductor real y la extensión cargada en el navegador del autor; no con Tampermonkey. Guía: [LEEME](tools/puente-atresplayer/LEEME.md) |
| Guía (programa en emisión y siguiente) e iconos de los canales de Atresmedia, desde una guía comunitaria | 🧪 Probado poco · se ha visto la guía de los seis canales y sus iconos; depende de un archivo de terceros |
| Quitar un canal propio desde su fila de la lista o desde el botón bajo la imagen | ✅ Hecho |
| Mediaset dentro de TDT local | 📋 Pendiente · su reproductor prohíbe incrustarse; hoy sus canales abren su web |
| Sacar el enlace de un directo desde tu navegador y añadirlo como canal propio (`tools/capturar-directo.js`) | 🧪 Probado poco · con una página de ejemplo, no con la web real de ninguna cadena |
| Ventana propia en lugar de abrir el navegador | 🧪 Probado poco · es la aplicación de escritorio de arriba |
| Controles propios del reproductor: calidad, pistas de audio, estadísticas, «volver al directo», retroceso | 📋 Pendiente |
| Reproductor ampliable con plugins (el sonido y la reacción a anuncios serían los primeros) | 📋 Pendiente |
| Sustituir los anuncios por otro contenido | 📋 Pendiente |
| Modo compatible con ffmpeg para formatos que el navegador no reproduce | 📋 Pendiente |
| Instaladores firmados, y en winget, Homebrew y APT | 📋 Pendiente |

## Letra pequeña (con cariño)

**De dónde sale esto.** Empezó como un visor de tele para mi propio PC: uno que no me pidiera abrir seis
apps de seis cadenas para ver el telediario. Lo enseñé en [Twitter](https://x.com/cibernicola_es/status/2116114114686627845), la gente preguntó «¿y eso dónde se
baja?» y aquí estamos: el repositorio es público por vuestra culpa (y me alegro). No es un producto, no tiene
hoja de soporte y la versión 1.0.0 se llama así porque el contador tenía que empezar en alguna parte.

**Cómo está hecho.** «Vibecodeado»: lo he ido construyendo conversando con una IA (Claude), yo dirigiendo, probando y
diciendo «eso no» de vez en cuando. Hay más de 400 pruebas automáticas, lo que demuestra que pasan, no que el código
sea perfecto. Funciona en mi máquina™ y también en la CI de GitHub, que ya es algo más que mi máquina.

**Seguridad: sed prudentes.**
- Es un servidor web que hace de *proxy* y que, si le dices dónde está `whisper-server`, ejecuta ese programa. Tiene
  defensas (están en [SECURITY.md](SECURITY.md)), pero que yo no haya encontrado fallos no significa que no estén:
  lo razonable es suponer que los hay.
- Pensado para escuchar solo en `127.0.0.1`. **No lo expongas a internet** y usa `--lan` solo en redes de confianza:
  no hay autenticación.
- Si pones una clave de API en Ajustes se guarda en tu equipo, en `settings.json`, en claro. Mejor una clave que
  puedas revocar, o pásala por la variable `TDT_LLM_API_KEY`.

**Errores.** Más que probables. Los instaladores no están firmados y los de macOS y Linux no se han probado en
máquinas limpias (la CI arranca la aplicación empaquetada, pero no es lo mismo que instalarla en un equipo de verdad). Los enlaces de las cadenas cambian y caducan cuando les da la gana. Los subtítulos con Whisper
alucinan con música y con voces solapadas. Si algo se rompe, llámalo «función sin documentar».

**Sin garantías ni parentesco.** Es software libre bajo [Apache 2.0](LICENSE), que dice en mayúsculas que se ofrece
«tal cual». No tengo relación con TDTChannels ni con ninguna cadena: yo solo enlazo lo que ellos publican. Sin su
trabajo esto no existiría; si ves algo bien, el mérito es suyo, y si ves algo mal, es mío.

**Cómo ayudar.** Se agradece todo: una *issue* contando que no te funciona, una idea, un «esto lo harías mejor
así», un *pull request* o un tuit. Lo único que pido es que, si encuentras un agujero de seguridad, no lo cuentes
con todos los detalles en público antes de avisarme ([cómo](SECURITY.md#cómo-informar-de-una-vulnerabilidad)). Más
sobre cómo colaborar en [CONTRIBUTING.md](CONTRIBUTING.md).

## Instalar

Descarga el instalador de tu sistema de la página de
[Releases](https://github.com/cibernicola/tdt-local/releases/latest) (incluye todo lo necesario, no hace falta Python): **Windows** `.exe` (o `.zip` portable), **macOS 13 o superior** `.dmg` (Intel o Apple Silicon), **Linux** `.deb` o `.tar.gz`. Desde la 1.3.0 instalas **la aplicación de escritorio** (ventana propia con Chromium integrado, icono en la bandeja y plugins), no la que abre tu navegador, y por eso pesan del orden de cien megas.
Los paquetes no están firmados, así que Windows y macOS avisarán la primera vez: en
[docs/INSTALLERS.md](docs/INSTALLERS.md) está qué hacer, dónde guarda los datos y cómo se construyen. Si vienes de una versión anterior, tus listas y canales propios se conservan; **los favoritos y el volumen que guardó tu navegador no pasan**, son de otro perfil.

## Arrancar desde el código

Hace falta Python 3.9 o superior.

**Aplicación de escritorio con plugins:** además hace falta Node 20 o superior. `cd desktop`, `npm install` y `npm start` (para empaquetarla, `npm run pack` tras `python packaging/build.py --server-only`). [docs/DESKTOP.md](docs/DESKTOP.md) explica cómo es y qué falta.

- **Windows:** doble clic en `iniciar.bat`.
- **Linux / macOS:** `./iniciar.sh`
- **A mano:** `python -m tdtlocal --open`
- **Con pip:** `pip install .` y luego `tdt-local --open` (o `tdt-local-app`, la versión de escritorio)

Se abre `http://127.0.0.1:8788/`. Para cerrarlo, Ctrl+C en la ventana. La primera vez hace falta
conexión para descargar las listas; después se usa la última copia guardada en `data/`.

## Qué hace

- **Listas al día:** descarga las listas al arrancar y las revisa cada 6 h (con ETag, así que no
  baja nada si no han cambiado). Botón «Actualizar lista» para forzarlo.
- **Reproducción:** directos HLS con hls.js (incluido en `tdtlocal/static/vendor/`, sin CDN). Todo
  pasa por un proxy local (`/proxy`) porque casi ningún stream envía cabeceras CORS.
- **Radio:** selector «Televisión / Radio» (o `T`) con unas 980 emisoras. mp3/aac/«stream» van
  directos al reproductor del navegador y las de m3u8 con hls.js. Se muestra el logo en lugar de vídeo.
- **Comprobar canales:** pide a cada stream su lista, una variante y el último segmento (en radio,
  los primeros bytes de audio) y marca cada uno en verde o rojo. «Ocultar caídos» los filtra.
- **Multivisión** (`V`): cuatro canales a la vez; solo suena la casilla activa. Clic en una casilla
  (o `← →`) le pasa el audio. «Cuadrícula» reparte 2×2 y «Foco» agranda la activa. «Rotar» pasa el
  audio a la siguiente casilla cada 10–60 s.
- **Guía de programación (EPG):** descarga cada hora los XMLTV de TDTChannels y los casa con la
  columna «EPG ID». Muestra el programa en emisión y el siguiente; `G` abre la programación completa
  del canal activo. Cubre unos 175 canales de tele y unas 50 emisoras; `--no-epg` la desactiva.
- **YouTube:** los canales cuyo directo es una página de YouTube se reproducen con el reproductor
  oficial incrustado, también en el mosaico. No pasan por el proxy.
- **U7D** (botón junto a Televisión y Radio): los canales con «últimos 7 días» (hoy, los de RTVE: La 1, La 2, 24 Horas,
  Teledeporte y Clan). Al entrar en uno salen sus programas de la última semana, del más reciente al más antiguo, con su
  miniatura y un buscador; un programa se reproduce como un canal, en la vista simple o en cualquier casilla de la
  multivisión. RTVE publica la lista y cada grabación por su API pública y TDT local las lee con sus cabeceras de
  siempre, sin hacerse pasar por su web. Los programas con DRM (películas y series con licencia, unos 3 de cada 10)
  no se reproducen y la casilla lo dice. La lista se guarda diez minutos y las miniaturas solo se piden para las filas
  que se ven.
  **Atresmedia (solo en la aplicación de escritorio):** Antena 3, laSexta, Neox, Nova, Mega y Atreseries salen también
  en U7D. Atresplayer publica lo emitido en una página pública por canal («Emitido en TV», `/antena3/u7d/`…) que solo
  un navegador puede leer. Al entrar en uno de esos canales, la aplicación abre una ventana «Explorar Atresplayer» con
  esa página, el plugin `tools/atresplayer-u7d` lee los programas que muestra (título, día, hora y miniatura) y la
  ventana se cierra sola. **Los programas no se reproducen dentro de TDT local:** el reproductor incrustado de
  Atresplayer (`/embed/video/…`) no reproduce estas grabaciones (en las pruebas, su propia petición
  `player/v1/video/<id>` responde 404), así que al elegir uno se abre **la página de la grabación en Atresplayer, en una
  ventana de la aplicación** (comparte datos con la de exploración: la respuesta a su aviso de cookies es tuya y se
  recuerda; con «Abrir en tu navegador» se ve fuera). **Atresplayer exige que se carguen sus anuncios:** si tu red los
  bloquea (un Pi-hole, AdGuard Home o un DNS que filtra publicidad), su página dice «Hemos detectado que tienes un
  bloqueador de publicidad» y no reproduce; el Registro lo deja ver (muchos `ERR_NAME_NOT_RESOLVED` de dominios de
  anuncios). Hay que permitir esos dominios para ver con anuncios, o entrar con una cuenta Premium. Hace falta activar el
  plugin en Ajustes ▸ Plugins. No imita la web de la cadena ni llama a su API: lee lo
  que la página muestra, y lo que sale es la selección de la propia web (unas decenas de programas por canal, no toda
  la parrilla). El aviso de cookies de esa ventana es tuyo. Mediaset no está: su reproductor no se puede incrustar.
- **Registro** (Ajustes ▸ Registro, solo en la aplicación de escritorio): lo que ha pasado en la aplicación (arranque,
  plugins, ventana de exploración, servidor, errores de la página y fallos de red de los reproductores de dentro, una
  vez por dirección y sin parámetros) para leerlo, filtrarlo, copiarlo o guardarlo en un archivo y enviarlo si algo
  falla. También queda en `<datos de la app>/logs/tdt-local.log` (se rota a 1 MB). Se ocultan claves, tokens y
  cabeceras de credenciales; aun así, léelo antes de enviarlo: puede incluir direcciones de canales y de páginas.
- **Canales propios:** «Añadir canal» guarda un enlace que pegues tú (m3u8, mp3/aac o YouTube) en
  `data/custom.json`, con cabeceras `Origin`/`Referer` opcionales que el proxy envía con la lista y
  con cada segmento. No se salta DRM ni geobloqueos: solo cabeceras. Para no copiar el enlace a mano hay un
  [fragmento para tu navegador](#sacar-el-enlace-de-un-directo-desde-tu-navegador).
- **Atresmedia con un clic:** «Añadir canal» tiene un botón que añade Antena 3, La Sexta, Neox, Nova, Mega y Atreseries
  con el reproductor oficial incrustable de Atresplayer (`https://www.atresplayer.com/embed/live/<canal>/`), igual que los
  de YouTube: se ve **su** reproductor, con sus anuncios y su aviso de cookies, y hay que pulsar «Directo». No pasa por el
  proxy, así que no hay subtítulos, marcas de anuncios ni igualador de sonido. Para que
  TDT local sepa cuándo hay publicidad y pueda silenciarlo (imprescindible en multivisión, donde solo debe sonar una
  casilla) hace falta el [script del puente](#publicidad-en-el-reproductor-de-atresplayer).
  Los ya añadidos no se repiten, y los canales propios se ven siempre, aunque esté marcado «Solo con directo».

  **Guía e iconos:** TDTChannels no incluye los canales de Atresmedia ni su guía, así que estos canales traen su propio
  icono y su identificador en una **guía comunitaria** (XMLTV, `EPG_dobleM`, de David Muma). Al pulsar el botón se activa
  la **guía extra** (Ajustes ▸ Listas y guía): solo lee de ese archivo, que pesa unos 35 MB, los canales tuyos que lo
  necesitan, y lo mira con su ETag unas pocas veces al día. Con eso salen el programa en emisión y el siguiente, la barra
  de progreso y la guía completa del canal, como en los demás. Se puede desactivar, o cambiar de fuente, en los ajustes. Si
  ya tenías esos canales añadidos de antes, vuelve a pulsar el botón para que reciban la guía y el icono.

  **Un canal, varias fuentes:** si ya tienes un canal propio con el mismo nombre (por ejemplo «La Sexta» con un enlace de
  stream), el reproductor de Atresplayer se añade como **otra fuente suya** en vez de crear un canal repetido, y lo mismo al
  pegar un enlace con el nombre de un canal que ya tienes. Al abrirlo se prueba primero el stream (con proxy: subtítulos,
  marcas de anuncios, igualador de sonido…) y, si no responde (por ejemplo, un enlace caducado), se pasa solo al reproductor
  de Atresplayer, que va siempre al final y nunca se queda como favorito. Con los botones numerados bajo el nombre del
  canal puedes elegir la fuente a mano.
  Para otro canal de Atresplayer, pega a mano `https://www.atresplayer.com/embed/live/<canal>/`.
- **Mediaset:** sus canales (Telecinco, Cuatro, FDF, Divinity, Energy, Be Mad y Boing) salen en la lista como «solo web»,
  con un botón que abre su página. Mediaset Infinity prohíbe que su reproductor se muestre dentro de otras páginas
  (`frame-ancestors`) y eso se respeta; si su reproductor da «Se ha producido un error · DAI», suele ser un bloqueador de
  anuncios (por ejemplo los escudos de Brave) cortando su módulo de publicidad.
- **Quitar un canal propio:** cada canal propio tiene una ✕ a la derecha de su fila (y el botón «Quitar canal» bajo la
  imagen, que sirve para el canal activo). Pide confirmación y, si el canal estaba en una casilla, la vacía. Los enlaces directos `.m3u8`
  de Atresplayer llevan un permiso **atado a la IP** desde la que se sacaron: si el navegador con el que se copian sale
  por otra IP que TDT local (por ejemplo, con una VPN), el servidor acepta la lista pero rechaza los segmentos (HTTP 492).
  Hay que sacar el enlace con un navegador que salga a internet igual que TDT local.
- **Asistente de IA** (`Ctrl+K`): órdenes como «pon La 2» o «pon La 2, TRECE y El Toro en
  multivisión rotando cada 30 s» se resuelven al instante en el navegador; el resto («hay fútbol
  ahora») va a tu modelo local, que solo recibe unas decenas de canales preseleccionados y no puede
  ejecutar nada que no esté en esa lista. Usa la API de chat de OpenAI de llama.cpp (`--llm-url`).
- **Subtítulos en directo** (`U`) y **alertas por voz**: ffmpeg saca el audio y `whisper-server`
  (whisper.cpp) lo transcribe en tu equipo; el audio no sale de él. Las alertas vigilan palabras en
  las cuatro casillas y, al oír una, resaltan la casilla y le pasan el audio.
- **Marcas de anuncios (SCTE-35)**, desactivado por defecto: busca la señal con la que las cadenas marcan dónde
  empieza y acaba la publicidad, avisa en pantalla y guarda cada hallazgo en `data/scte.jsonl` (se puede descargar
  en JSON o CSV). Ver [más abajo](#marcas-de-anuncios-scte-35). Opcionalmente, mientras dura una pausa, silencia o baja
  el sonido, cambia a otro canal o muestra una web ([Durante la publicidad](#durante-la-publicidad)).
- **Sonido** (botón *Sonido*): **igualador de volumen** (sube lo que suena bajo y baja lo que suena alto hasta un nivel
  que eliges) y **ecualizador** de 10 bandas con preajustes. Ambos se pueden fijar para todos los canales o solo para
  uno. Ver [más abajo](#sonido).
- Favoritos, último canal, volumen, filtros, mosaico y rotación se guardan en el navegador. Los
  logos se descargan una vez a `data/logos/`.

## Teclas

| Tecla | Acción |
|---|---|
| 0–9, Intro | ir al número de canal (el de la lista visible) |
| Re Pág / Av Pág, ↑ ↓ | canal anterior / siguiente |
| S · F · M · P · / | favorito · pantalla completa · silencio · ventana flotante · buscar |
| T · V · C · G | televisión/radio · multivisión · ocultar/mostrar la lista · guía |
| ← → · R | multivisión: cambiar de casilla activa · activar/parar la rotación |
| U · Ctrl+K | subtítulos en directo · asistente de IA |

## Ajustes

El botón **Ajustes** (abajo, en el panel de canales) abre la configuración. Todo se guarda en
`settings.json`, dentro de la carpeta de datos, y se aplica al momento, sin reiniciar.

- **Asistente de IA:** activarlo, dirección del servidor (API compatible con OpenAI, p. ej. llama.cpp o un servicio
  en línea), modelo (con «Probar conexión» se listan los que ofrece el servidor), clave de API opcional (se guarda en
  tu equipo y no se vuelve a mostrar), temperatura, máximo de tokens, tiempo de espera, pedir al modelo que no
  «piense» y parámetros extra en JSON (`top_p`, `top_k`…).
- **Subtítulos y alertas:** activarlos, idioma (o detección automática), modelo, carpeta de modelos, programa
  `whisper-server`, dirección del servidor, arranque automático, hilos y minutos de inactividad. Incluye un
  catálogo para **descargar modelos** de Whisper con progreso, cancelación y verificación SHA-256, y un botón
  «Comprobar» que dice qué falta (ffmpeg, el programa, el modelo, el servidor).
- **Listas y guía:** cada cuántas horas se actualizan, comprobar los streams tras actualizar, guía de programación,
  la **guía extra** para tus canales propios sin guía (desactivada hasta que añades los de Atresmedia) y, en «avanzado», las
  direcciones de origen (listas, guías y guía extra).

Los ajustes solo se pueden cambiar desde el propio equipo (aunque uses `--lan`): `whisper-server` es un programa
que se ejecuta y no debe poder elegirlo cualquiera de tu red.

- **Marcas de anuncios:** activar la vigilancia, qué vigilar (lo que ves, una lista de canales o todos), cada cuántos
  segundos explorar, mirar también dentro del vídeo, avisar en pantalla y cuántas marcas conservar.
- **Durante la publicidad:** qué hacer con el sonido y con la imagen cuando empieza una pausa, y qué pasa si tocas algo.

### Línea de comandos y variables de entorno

Lo que fijes por línea de comandos o con una variable `TDT_<AJUSTE>` manda sobre lo guardado: en Ajustes aparece
bloqueado y no se escribe en `settings.json`. Útil para scripts, contenedores o para no guardar una clave en disco
(`TDT_LLM_API_KEY`). Orden de prioridad: valores por defecto, lo guardado en Ajustes, y por último flag o variable.

```
--port 8788           puerto
--host ADDR           dirección donde escuchar (127.0.0.1)
--lan                 escuchar en toda la red local (tablet, móvil...), SIN autenticación
--open                abrir el navegador
--verbose             registrar cada petición HTTP
--quit-button         mostrar el botón «Salir», que cierra el servidor (lo usa la app de escritorio)
--data-dir DIR        carpeta de datos (por defecto ./data, o la carpeta de usuario si está instalado)
--interval HORAS      horas entre actualizaciones de la lista (6)
--auto-check          comprobar los streams de la tele tras cada actualización
--source URL          otra copia de TELEVISION.md
--radio-source URL    otra copia de RADIO.md
--epg-source URL      otro XMLTV (.xml o .xml.gz) para la tele
--radio-epg-source URL  otro XMLTV para la radio
--no-epg              no descargar la guía de programación
--llm-url URL         servidor de IA compatible con OpenAI (por defecto http://127.0.0.1:8080/v1)
--llm-model NAME      nombre del modelo, si tu servidor lo exige
--no-ai               desactivar el asistente
--models-dir DIR      carpeta de los modelos de Whisper
--whisper-url URL     whisper-server (por defecto :8178); si no responde, se lanza uno
--whisper-bin PATH    whisper-server (por defecto, el del PATH)
--whisper-model PATH  modelo ggml (por defecto, el primero de la carpeta de modelos)
--whisper-lang es     idioma del audio (o auto)
--no-stt              desactivar subtítulos y alertas
--version
```

Cualquier ajuste tiene su variable: el nombre del ajuste en mayúsculas con prefijo `TDT_` (`TDT_LLM_URL`,
`TDT_LLM_API_KEY`, `TDT_WHISPER_BIN`, `TDT_WHISPER_THREADS`, `TDT_STT_ENABLED=0`…). Los nombres están en
[`tdtlocal/settings.py`](tdtlocal/settings.py). `TDT_DATA_DIR` fija la carpeta de datos. En los lanzadores puedes
ponerlas en `iniciar.local.bat` / `iniciar.local.sh`, que no se suben a git.

### Subtítulos con Whisper

1. Instala [ffmpeg](https://ffmpeg.org/) y deja `ffmpeg` en el `PATH`.
2. Compila o descarga [whisper.cpp](https://github.com/ggml-org/whisper.cpp) y pon `whisper-server` en el `PATH`,
   o indica su ruta en Ajustes ➜ Subtítulos (o con `--whisper-bin`).
3. En Ajustes ➜ Subtítulos, elige un modelo del catálogo y pulsa **Descargar** (por ejemplo `large-v3-turbo-q5_0`,
   574 MB, el recomendado con GPU). Pulsa **Comprobar** para confirmar que todo está en su sitio.

Si no hay un `whisper-server` en marcha, TDT local lanza uno y lo apaga tras unos minutos sin uso.

## Marcas de anuncios (SCTE-35)

SCTE-35 es el estándar con el que una emisión marca dónde empieza y acaba una pausa publicitaria; el reproductor o el
servidor que inserta anuncios lo usa para saber cuándo cortar. TDT local puede buscarlo y dejar constancia. Se activa en
**Ajustes ▸ Marcas de anuncios** (o con `TDT_SCTE_ENABLED=1`) y, una vez activo, aparece el botón **Marcas**.

Dónde mira:

- **Lo que estás viendo:** cada lista de reproducción que pasa por el proxy se analiza al vuelo, sin descargar nada más.
  Busca `#EXT-X-CUE-OUT` / `CUE-OUT-CONT` / `CUE-IN`, `#EXT-X-DATERANGE` (con `SCTE35-OUT`, `SCTE35-IN`, anuncios
  intercalados de HLS u otros metadatos), `#EXT-OATCLS-SCTE35`, `#EXT-X-SCTE35` y variantes. Cuando la marca lleva el
  mensaje binario, se **decodifica** (`splice_insert`, `time_signal` y sus descriptores de segmentación: duración,
  tipo de pausa, identificador del evento) y se comprueba su CRC.
- **Exploración activa:** cada `scte_interval` segundos (60 por defecto) se descarga la lista de los canales que
  indiques, o de todos los que tienen directo, y se analiza igual. No se tocan los marcados como caídos.
- **Dentro del vídeo** (opcional): se baja el principio (256 KB) de un segmento por canal y se busca el PID de datos de
  SCTE-35 en la tabla PMT del MPEG-TS (`stream_type 0x86` o registro `CUEI`) o eventos `emsg` en fMP4. Sirve para saber
  si la señal *lleva* SCTE-35 aunque la lista de reproducción no lo muestre.

Qué guarda: cada hallazgo (fecha, canal, tipo, detalle, etiqueta original y mensaje decodificado) en `scte.jsonl`,
una línea por marca y sin repetir la misma marca mientras siga en la lista. Se conservan las últimas 2000 (ajustable).
La URL se guarda **sin los parámetros de la consulta**, que suelen llevar permisos temporales. El botón **Marcas** abre
el registro, permite explorar al momento, descargarlo (JSON o CSV) o vaciarlo; mientras está activo, una marca nueva
resalta el botón y se muestra en pantalla (se puede desactivar).

Lo que no hace: no salta ni bloquea anuncios (la reacción de la siguiente sección solo cambia el sonido o lo que ves
mientras dura la pausa), y no analiza la señal de radiofrecuencia de la TDT (solo los streams que enlaza TDTChannels).
Una marca solo vive unos segundos en la lista de reproducción, así que una
exploración cada minuto puede perder pausas cortas; lo que ves en pantalla se analiza siempre. Que un canal no
muestre marcas no prueba que no las use: muchas cadenas insertan los anuncios en el servidor y no dejan rastro.

## Sacar el enlace de un directo desde tu navegador

Para un canal propio hay que pegar el enlace `.m3u8` del directo. `tools/capturar-directo.js` lo saca por ti **de lo que tu
navegador ya está reproduciendo**:

1. Abre la página del directo (por ejemplo la de laSexta en atresplayer.com), acepta o rechaza las cookies como prefieras
   y deja que el vídeo empiece.
2. Pulsa F12, abre la pestaña **Consola**, pega todo el contenido de `tools/capturar-directo.js` y pulsa Intro (si el
   navegador lo pide, escribe antes `allow pasting`). Si TDT local no está en el puerto 8788, cambia `PUERTO` al principio.
3. Se abre una pestaña de TDT local con el diálogo **Añadir canal** relleno (nombre, enlace y, en Atresplayer, las
   cabeceras). Revísalo y pulsa **Añadir**. El enlace también queda copiado al portapapeles.

Qué hace y qué no: lee las listas `.m3u8` que la propia página ya ha pedido (lo mismo que se ve en la pestaña *Red* de las
herramientas del navegador) y elige la más probable; no hace ninguna petición a la web, no se salta registros, DRM ni
geobloqueos, y no funciona con lo que el navegador no esté reproduciendo. Los enlaces suelen llevar un permiso temporal
y **caducan**: cuando el canal deje de verse, repite el proceso. El enlace con el que se abre TDT local lleva todo en el
fragmento (`#…`), que el navegador no envía a ningún servidor, y la página lo borra de la barra de direcciones al leerlo.
Solo rellena el formulario: no añade nada hasta que pulsas el botón.

## Sonido

El botón **Sonido** abre un diálogo con dos herramientas, que se pueden usar a la vez:

- **Igualar el volumen:** mide cuánto suena el canal (en una escala tipo LUFS, ponderada como ITU-R BS.1770) y ajusta
  la ganancia hasta el **nivel al que igualar**. Es un control automático en los dos sentidos: sube los canales que
  suenan bajos (hasta el máximo que indiques, 12 dB por defecto, para no amplificar ruido) y baja los que suenan altos
  (hasta 24 dB), rápido cuando llega algo fuerte —un anuncio— y despacio al subir, para que no «bombee». Al sintonizar
  un canal se adapta en unos segundos. Un limitador evita que lo que sube llegue a saturar. El silencio no se amplifica.
- **Ecualizador:** diez bandas (31 Hz a 16 kHz, ±12 dB) y preajustes (plano, voz clara, graves, agudos, en V, noche).

Cada ajuste vale **para todos los canales** o **solo para el canal que ves**: un canal con ajuste propio manda sobre el
global, y cada parte (igualador, ecualizador) se puede dejar propia o volver a la global por separado. Se guardan en el
navegador. El diálogo muestra en vivo cuánto llega el canal y cuánto lo corrige.

El volumen y el silencio de siempre siguen funcionando igual: el igualador descuenta el volumen que tengas puesto, así
que bajarlo no hace que el igualador lo suba otra vez. Funciona también con la radio. Límites: el sonido de YouTube no
se puede procesar (va en un iframe ajeno); el navegador solo permite procesar audio tras un primer clic o tecla en la
página; y como mide en directo y sin mirar adelante, es un control aproximado, no una normalización EBU R128 estricta.

**El sonido del reproductor de Atresplayer** tampoco se puede tocar desde fuera (otro origen), pero con el
[puente](#publicidad-en-el-reproductor-de-atresplayer) **instalado como extensión** (la carpeta entera
`tools/puente-atresplayer`, que lleva `audio-chain.js`) sí: TDT local le manda los ajustes del canal (igualador de
volumen y ecualizador, globales o propios) y el puente aplica la misma cadena **dentro** del reproductor, sobre su
`<video>`; el diálogo «Sonido» muestra lo que oye y corrige. El volumen y el silencio funcionan igual que antes. Con el
script pegado solo en Tampermonkey o en la consola no hay igualador ni ecualizador (solo silencia y avisa de la
publicidad). `audio-chain.js` se genera a partir del código de la página con `python scripts/build_bridge.py`, y una
prueba falla si se queda desfasado.

## Durante la publicidad

**Ajustes ▸ Durante la publicidad** permite que la página reaccione cuando el canal que estás viendo entra en una pausa
de anuncios. Hay dos formas de enterarse: con un canal con stream, la vigilancia de marcas (solo actúa si el canal envía
la marca SCTE-35; La Sexta, por ejemplo, la envía); y con el reproductor incrustado de Atresmedia, el
[script del puente](#publicidad-en-el-reproductor-de-atresplayer).

- **Aviso fijo:** un rótulo rojo «PUBLICIDAD» sobre la imagen mientras dura la pausa (se puede desactivar).

- **Con el sonido:** no tocarlo, silenciarlo o bajarlo a un porcentaje del volumen que tengas.
- **Con la imagen:** dejarla, cambiar a otro canal (por nombre o identificador) o mostrar una web sobre la imagen.
  Algunas webs no permiten que se muestren dentro de otra página: el botón **Comprobar** de los ajustes lo avisa. Solo se
  permite esa dirección en la política de seguridad de la página.
- **Cuándo termina:** al llegar la marca de fin de pausa, o cuando pasa la duración que dice la marca (más 3 s). Si la
  marca no dice cuánto dura, se supone el tiempo que indiques (120 s por defecto). Al cambiar de canal, en vista simple el
  canal original **sigue en segundo plano** (en otra casilla, fuera de la vista y silenciado): así se sigue viendo cuándo
  acaba la pausa, se vuelve a él al instante y no hay que cargarlo otra vez (el reproductor de Atresplayer, al cargarse,
  empieza siempre con un anuncio y volvería a provocar otro cambio). En multivisión se cambia la propia casilla y se vuelve
  por tiempo; para no entrar en bucle, un anuncio que aparece en los 90 s siguientes a volver a cargar un canal no provoca
  otro cambio.
- **Pausas cortas:** se ignoran las que dicen durar menos de unos segundos (10 por defecto).
- **El anuncio de arranque:** en el reproductor de Atresplayer, el anuncio que sale al pulsar «Directo» (o cuando el
  reproductor se reinicia) llega sin programa antes. Ese anuncio solo silencia y muestra el rótulo; **no cambia de canal**,
  porque dura unos segundos y, si el reproductor se reinicia al volver, provocaría un bucle (pulsar «Directo», anuncio,
  cambio de canal, volver, «Directo»…). Se considera de arranque el que llega con menos de 20 s de programa seguidos
  antes, y para saberlo el puente cuenta si el reproductor está emitiendo. Las pausas que llegan después de 20 s o más de
  programa sí cambian de canal.
- **Si tocas algo durante la pausa** (el volumen o el canal): puedes elegir *respetar lo que hagas*, de modo que no se
  deshaga nada más, o *dejarlo todo como estaba* al terminar la pausa (volumen anterior y canal original).

### Publicidad en el reproductor de Atresplayer

> **La guía completa de la extensión** (qué hace y qué no, instalación paso a paso, cómo comprobarla, problemas
> frecuentes y cómo funciona) está en [tools/puente-atresplayer/LEEME.md](tools/puente-atresplayer/LEEME.md). Lo que sigue
> es el resumen.

El reproductor incrustado de Atresplayer está en otro origen y el navegador no deja que TDT local vea lo que pasa dentro; el
reproductor tampoco avisa al exterior. Lo que sí hay dentro es el aviso «Publicidad» que te enseña a ti. Para que TDT local
se entere hay que poner en marcha `tools/puente-atresplayer` en **tu** navegador: se ejecuta dentro del reproductor, lee ese
aviso y se lo cuenta a TDT local con un mensaje. Con eso TDT local muestra su aviso fijo, cambia de canal o abre una web, y
puede **silenciar el sonido** del reproductor mientras dura la pausa (y con la tecla `M`), también en multivisión: la casilla
activa suena y las demás se silencian, y al rotar el audio el puente lo sigue. Sin el puente, en multivisión los
reproductores de Atresplayer sonarían a la vez en cuanto pulsas «Directo» en cada uno, y la casilla lo avisa. No hace
peticiones, no salta ni toca la publicidad y solo habla con la página de TDT local que lo incrusta (en Chrome, Edge y Brave
comprueba que es `127.0.0.1` o `localhost`).

**Cómo ponerlo en marcha**, en el navegador donde abres TDT local (hay tres formas; la primera no necesita gestor de scripts):

1. **Como extensión** (recomendado): la carpeta `tools/puente-atresplayer` es una extensión sin permisos. En
   `brave://extensions`, `chrome://extensions` o `edge://extensions` activa el **Modo de desarrollador**, pulsa **Cargar
   descomprimida** y elige esa carpeta. Chrome avisa al arrancar de que hay extensiones sin publicar.
2. **Con Tampermonkey o Violentmonkey:** crea un script nuevo y pega `tools/puente-atresplayer/puente.user.js`. En las
   versiones recientes de Chrome, Edge y Brave estas extensiones piden además activar **«Permitir scripts de usuario»** en
   sus detalles (y, según la versión, el modo de desarrollador); sin eso el script no se ejecuta.
3. **Prueba suelta, sin instalar nada:** con TDT local abierto en un canal de Atresmedia, F12 ▸ Consola, elige en el
   desplegable «top» el contexto de `atresplayer.com` y pega el archivo. Vale hasta que recargues la página.

**Cómo saber que funciona:** al abrir un canal de Atresmedia, la línea bajo el nombre del canal dice «puente activo»; si a
los 6 segundos no ha dado señales, dice «puente no detectado». El script escribe en la consola (F12) mensajes que empiezan
por «[TDT puente]». Pegarlo en la consola de la página de TDT local, o de la pestaña suelta del reproductor, solo comprueba
que el código se ejecuta: no lo deja conectado a la casilla.

**Qué mira el puente:** dos textos del propio reproductor, visibles en la parte de arriba: el corto «Publicidad» (el anuncio que
sale al pulsar «Directo», unos 25 s, comprobado sobre el reproductor real) y el aviso «El canal que estás viendo en directo se
encuentra en estos momentos en publicidad» de las pausas del directo (visto en una captura, no comprobado en directo por el
programa). Los dos desaparecen al terminar. Si el reproductor usa otro texto, el puente no lo verá: se añade a la lista
`FRASES` del script, y la consola dice qué texto ha visto en cada pausa («[TDT puente] publicidad: empieza (…)»). «Bajar el volumen» silencia en vez de bajar, porque el puente solo
sabe silenciar.

La reacción se calcula para el momento en que la pausa *se ve*, no cuando se encuentra la marca, que llega a la lista
unos segundos antes. Si abres el canal con la pausa ya empezada, se une a lo que queda. El canal cambiado no se guarda
como «último canal visto». Todo es desactivable y está desactivado por defecto.

## Seguridad

TDT local es una herramienta **personal para tu propio equipo**.

- Por defecto solo escucha en `127.0.0.1` y rechaza peticiones cuyo `Host` no sea local
  (protege frente a DNS rebinding), de otro origen (`Sec-Fetch-Site`, `Origin`) o con rutas fuera
  de `tdtlocal/static/`.
- El proxy solo acepta hosts que salen de las listas (o de redirecciones de streams ya validados),
  solo `http(s)`, y rechaza siempre direcciones no públicas (loopback, red local, metadatos de la
  nube).
- Cabecera `Content-Security-Policy` estricta: sin scripts ni estilos en línea. Solo se
  puede incrustar YouTube y, si lo configuras, la web de las pausas de anuncios.
- El modelo de IA no es de fiar: sus respuestas se validan y solo se aceptan acciones y canales
  de la lista que se le ofreció.
- `--lan` abre la app a toda tu red local **sin autenticación**: úsalo solo en redes de confianza.

Para avisar de un problema de seguridad, mira [SECURITY.md](SECURITY.md).

## Límites

- Hay canales sin directo abierto en la lista (p. ej. Cuatro y Telecinco): salen como «solo web» y
  se ofrece el enlace a su página. No se intenta saltar ningún DRM ni geobloqueo.
- Los streams cambian de URL a menudo. Si uno falla, prueba la otra fuente (botones 1, 2…) o
  actualiza la lista.
- Whisper falla con música y con emisiones fMP4/CMAF; cada casilla transcrita gasta algo de GPU.
- Si cierras el servidor a la fuerza (sin Ctrl+C) puede quedar un `whisper-server` huérfano.
- Si la lista descargada trae menos de 50 canales (30 en radio) se descarta y se conserva la
  anterior, por si el formato del repositorio de origen cambia.
- Los logos de `graph.facebook.com` de la lista ya no cargan; se muestran las iniciales.

## Desarrollo

```
python -m unittest discover -s tests -t .            # pruebas de Python (sin dependencias)
node --test                                           # pruebas del código del navegador (Node 20+)
python scripts/check.py                               # todo lo anterior y el lint, si está instalado
pip install ruff pytest && ruff check . && ruff format --check .
```

La arquitectura está en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) y la guía para contribuir en
[CONTRIBUTING.md](CONTRIBUTING.md). Los cambios están en [CHANGELOG.md](CHANGELOG.md) y lo que
falta por hacer, en [ROADMAP.md](ROADMAP.md).

```
tdtlocal/            paquete de Python (servidor, proxy, EPG, IA, transcripción)
tdtlocal/static/     interfaz: index.html, style.css y módulos ES en js/ (lib/ = lógica pura)
tdtlocal/static/vendor/  hls.js (Apache-2.0, con su licencia)
packaging/           PyInstaller, Inno Setup, .dmg, .deb y el script de construcción de instaladores
tests/               pruebas de Python (tests/*.py) y del navegador (tests/js/)
docs/                documentación técnica
data/                (se crea solo, no se versiona) listas, estado, logos y canales propios
models/              (no se versiona) modelo de Whisper
```

## Créditos, licencia y aviso

- Las listas de canales y las guías son de [TDTChannels](https://github.com/LaQuay/TDTChannels)
  (Apache-2.0; las guías las sirven tdtchannels.com y [Onda Channels](https://www.ondachannels.com/) y están sujetas a su
  [aviso legal](https://www.tdtchannels.com/aviso-legal/)). Sin su trabajo esto no existiría.
- La **guía extra** de los canales de Atresmedia (programación e iconos) viene de
  [EPG_dobleM](https://github.com/davidmuma/EPG_dobleM) y [picons_dobleM](https://github.com/davidmuma/picons_dobleM),
  de David Muma: archivos de terceros, que no se incluyen y que se descargan solo si activas esa guía. Comprueba sus
  condiciones de uso antes de depender de ellos.
- [hls.js](https://github.com/video-dev/hls.js) (Apache-2.0, © Dailymotion) reproduce el HLS en el navegador.
- Opcionales y no incluidos: [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT),
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) y [FFmpeg](https://ffmpeg.org) (LGPL/GPL).
- Los instaladores incluyen el intérprete de Python (licencia PSF) y se construyen con PyInstaller.
- TDT local no aloja ni redistribuye ningún contenido: es un reproductor que enlaza los directos que
  las propias cadenas publican abiertamente. Los canales y su contenido pertenecen a sus titulares.

### Licencia

[Apache License 2.0](LICENSE). Es libre: puedes usarlo, modificarlo y redistribuirlo, incluso con fines
comerciales, **a condición de citar su origen**: conserva el aviso de copyright, el fichero [NOTICE](NOTICE) (con la cita de
TDTChannels, hls.js y el resto) y marca los cambios que hagas. Los créditos también salen en la propia aplicación,
en «Créditos y licencias». Detalle de las licencias de terceros en [NOTICE](NOTICE).
