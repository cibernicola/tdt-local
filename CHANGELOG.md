# Cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); el proyecto sigue
[SemVer](https://semver.org/lang/es/).

## [Sin publicar]

## [1.5.0] — 2026-11-11

**La versión de los plugins.** TDT local deja de ser solo un visor y pasa a poder cambiarse por dentro: **cuatro clases de plugin** (de página, con permisos aislados, con todo el poder y de desarrollo),
**ganchos** para mirar, cambiar o reemplazar lo que hace la aplicación (la reacción a la publicidad ya es un plugin incluido), **capas** sobre la imagen, **temas** completos, **reglas** sin código, un **bus de
control y un servidor MCP** para que lo maneje una IA, **modo seguro**, **inspector**, **límites** por plugin, instalación por enlace o catálogo con **firma de autor**, y un repaso de seguridad de todo el código.
Todo esto es **de la aplicación de escritorio** y se ha probado en **Windows**; en macOS y Linux los instaladores se construyen y arrancan, pero los plugins no se han probado. El MCP está probado con un cliente
independiente y con **Claude Code** (un banco que lo arranca de verdad: `scripts/plugin-lab/mcp-claude.mjs`), **no** con Claude Desktop ni con otros. Léete [SECURITY.md](SECURITY.md): un plugin con todo el poder no tiene caja. Lo que **no** hay todavía: plugins que corran en el servidor de Python, el alcance
`main` en los plugins que se instalan, plantillas de interfaz y temas hijo, y un reproductor propio por plugin.

### Funciones
- **El MCP, probado con Claude Code.** El banco `scripts/plugin-lab/mcp-claude.mjs` arranca la aplicación real con el acceso de IAs encendido y a Claude Code (`claude -p`) con solo el servidor MCP de TDT local permitido, y le pide un recorrido; lo que hizo se lee de su propia transcripción (cada llamada y su respuesta) y lo que cambió se mira en la página, no en lo que el modelo cuenta. Conecta, ve las **30 herramientas**, lee el estado, busca canales, cambia el volumen (la página lo refleja), lee eventos y la especificación de la API, **escribe un tema con `dry_run` y de verdad (el usuario contesta la pregunta), lo activa y la página lo aplica**, y lista plugins y reglas: 13 de 13 comprobaciones, sin ninguna llamada con error, **por entrada y salida estándar y por HTTP** (`MCP_CLAUDE_TRANSPORT=http`). Gasta un poco de tu Claude Code en cada ejecución, así que no está en la CI ni en los demás bancos.
- **Ganchos y plugins con todo el poder (hito 1 de [docs/HACKEABLE.md](docs/HACKEABLE.md)).** La aplicación empieza a dejar que otros miren, cambien o
  reemplacen lo que hace, con tres piezas iguales en la página (`static/js/lib/hooks.js`) y en el servidor (`tdtlocal/hooks.py`): **acciones** (`on`/`do`: algo ha
  pasado; es el bus de eventos de siempre, ahora con prioridad), **filtros** (`filter`/`apply`: un valor pasa por una cadena y cada eslabón puede cambiarlo; los
  de menor prioridad primero; un eslabón que falla se salta) y **registros** (`register`/`get`/`list`: gana la menor prioridad, a igualdad el último; al quitar uno vuelve
  el anterior). Un **cargador** (`lib/trusted.js`, `tdtlocal/trusted.py`) da a cada plugin su `tdt`, apunta todo lo que añade para quitarlo entero, y no deja que sus
  fallos lleguen a la aplicación: cinco y se apaga solo ese plugin.
- **La reacción a la publicidad es ahora un plugin incluido (`static/plugins/ads/`).** El motor (`adbreak.js`) averigua cuándo empieza y acaba una pausa y avisa con los
  eventos nuevos **`ad.started`** y **`ad.ended`** (también para los plugins aislados y por MCP, con el permiso `player.read`); lo que se hace lo dicen el filtro
  `ad.reaction` (una lista de pasos, por defecto lo elegido en Ajustes) y el registro `ad.actions` (cartel, audio, canal, web, aviso). Otro plugin puede añadir pasos,
  quitarlos o reemplazar una acción, y al apagarse vuelve lo de siempre. En el servidor, cada marca nueva se cuenta como la acción `ad.marker`.
  **El comportamiento por defecto es el mismo** (comprobado con 9 pruebas del motor con casilla y página simuladas, y mirándolo en una página real); solo cambia que al
  terminar cada paso deshace lo suyo en el orden del plan y ya no toca lo que no hizo.
- **Los plugins de desarrollo reciben los ganchos.** Su `page.js` (sin aislamiento) recibe ahora el mismo `tdt` que los plugins incluidos: `tdt.on`, `tdt.filter`,
  `tdt.register`, `tdt.do`, además de `tdt.log` y `tdt.error`, y lo carga el mismo cargador (`dev:<nombre>`: un fallo se cuenta y se salta, y con cinco se apaga solo ese plugin). Corre dentro de una
  función `async`: **admite `await` al principio** (antes era un error de sintaxis) y `return () => …` para limpiar al apagarse. **Corregido:** `tdt.on` da `(datos, nombre)`, no `(nombre, datos)`.
  El **inspector** muestra qué plugins con ganchos hay, su estado y sus fallos. Probado en la aplicación real (`scripts/plugin-lab/hooks.mjs`, 9 comprobaciones). Falta que lo pueda instalar un
  usuario sin el modo desarrollador, y la parte de servidor.
- **Temas completos** ([docs/TEMAS.md](docs/TEMAS.md)). Un plugin con todo el poder con `"tdt": {"api": 1, "full": {"css": "tema.css"}}` es un tema: una **hoja de estilo** que se aplica después de la de la
  aplicación (gana en un empate; con hojas «constructables», que la política de la página permite), así que puede cambiar cualquier regla, no solo 12 colores, **sin ejecutar código**. Sus imágenes y fuentes (`png jpg gif webp svg ico`,
  `woff woff2 ttf otf`, hasta 1 MB cada una y 4 MB en total) tienen que estar en su carpeta y se **incrustan en la hoja** al entregarla (una dirección con esquema, `//…` o `@import` es un problema); la política de la página
  permite ahora fuentes `data:` (`font-src 'self' data:`). **Solo hay un tema a la vez** (activar uno apaga el anterior). La pregunta de activación enseña la hoja y dice que un tema es mucho menos que un plugin con
  código; la aprobación sigue atada a la huella de toda la carpeta (imágenes incluidas). Con `page` además tiene código, y un `page.js` puede poner hojas con **`tdt.css(texto)`**. *Ajustes ▸ Plugins* lo
  llama «Tema». El **contrato** de nombres estables (variables, clases, ids) está en TEMAS.md. Los temas de 12 colores de `tdt.themes` siguen igual. Probado en la aplicación real (`scripts/plugin-lab/full.mjs`,
  ahora 21 comprobaciones) y con 8 pruebas nuevas. Faltan las plantillas (reemplazar la estructura de la casilla o la fila) y los temas hijo.
- **Capas sobre la imagen de cada casilla (ranura `tile.overlay`).** Un plugin con todo el poder (o de desarrollo) registra `tdt.register('tile.overlay', id, { mount(ctx) { … return {el, update, destroy}; } })` y su
  capa aparece en cada casilla, por encima de la imagen y de la barra, **sin tapar los clics** (los deja pasar salvo `pointer-events: auto`). `mount` se llama una vez por casilla con `{tile: {index, focus, channel}, mode}`
  y puede no querer una casilla (se le vuelve a preguntar cuando algo cambia); `update(ctx)` se llama al cambiar el canal, el foco o la vista; al apagarse el plugin, o al reemplazarla otra con el mismo id,
  se quita y se llama a `destroy`. Un fallo en una capa se salta y se cuenta. Los registros de ganchos avisan ahora de sus cambios (`hooks.watch`), y deshacer un registro dos veces ya no falla.
  8 pruebas nuevas, comprobado en una página real y en la aplicación (`scripts/plugin-lab/hooks.mjs`, ahora 11 comprobaciones).
- **Una IA puede escribir plugins con todo el poder y temas, y hay botones para crearlos.** `tdt_plugin_write` (nivel de desarrollo del MCP) acepta ahora un manifest `tdt.full`: el usuario ve una ventana con otras
  palabras («un plugin con TODO el poder» o «un tema»), el código o la hoja de estilo, y decide; `dry_run` comprueba antes sin molestarle y avisa de lo que suele salir mal (`fetch()` a internet, `import` estático, no usar `tdt`). **Escribir no activa**, y como
  la aprobación es del código, lo que se escriba después detiene al plugin activado hasta que el usuario lo vuelva a activar. En *Ajustes ▸ Plugins*, junto a «Crear un plugin nuevo», están **«Crear un tema»** y
  **«Crear un plugin con todo el poder»**, con plantillas que ya funcionan; la guía para personas ([HACER-PLUGINS.md](docs/HACER-PLUGINS.md)) y la de las IAs lo cuentan. **Corregido:** una `url()` dentro de un comentario de la hoja de estilo ya no se trata como un recurso.
- **Plugins con todo el poder, que cualquiera instala (sin el modo desarrollador).** Un manifest `"tdt": {"api": 1, "full": {"page": "page.js"}}` es un plugin que corre **dentro de la página, sin aislar y sin permisos**,
  con los ganchos de la aplicación: el modelo de WordPress. Se instala como cualquier otro (archivo, enlace o catálogo; SHA-256 y firma de autor; **instalar no activa**) y se puede empaquetar. El aviso de instalación
  y el de activación dicen que **tiene todo el poder** y enseñan el principio de su código. **La aprobación es del código:** se guarda con una huella de todos los archivos de su carpeta, una sola letra cambiada
  lo detiene hasta que se vuelva a activar, y el código se relee al entregarlo a la página y tiene que dar la huella aprobada. Sin aviso permanente (es un plugin normal): sale en *Ajustes ▸ Plugins* como «Sin aislar», con su
  huella, y en el inspector. El modo seguro no carga ninguno y no deja activar. Solo existe el alcance `page`; `main` y `server` siguen para los de desarrollo. Una IA puede listarlos, escribirlos (con la confirmación del usuario, ver la entrada de arriba) y pedir que se activen (decide el usuario).
  **Un archivo que la huella no cuenta (oculto, o dentro de `node_modules`) no puede ser el código, la hoja de estilo ni una imagen** (cambiaría tras la aprobación sin que se viera). Probado en la aplicación real (`scripts/plugin-lab/full.mjs`, 15 comprobaciones) y con 11 pruebas nuevas (una, la del enlace dentro de la carpeta, se omite donde el sistema no deja crear enlaces).
- **Plugins con permisos** (aplicación de escritorio; fase A de [docs/PLUGINS.md](docs/PLUGINS.md), guía en
  [docs/HACER-PLUGINS.md](docs/HACER-PLUGINS.md)): una carpeta con `manifest.json` (`tdt.api: 1`) y una página HTML que corre
  **aislada** (marco `sandbox` sin origen propio, servido desde `tdt-plugin://<id>/` con una política que le cierra toda petición,
  marco, formulario y ventana) y solo habla con la aplicación por un SDK (`/@tdt/sdk.js`): `tdt.player` (estado, eventos, canal,
  lista, volumen, silencio, multivisión), `tdt.channels.search`, `tdt.epg.now`, `tdt.ui` (avisos y tamaño del panel),
  `tdt.storage` (256 KB propios) y `tdt.net.fetch`. Los permisos (`player.read`, `player.control`, `channels.read`, `epg.read`,
  `ui.toast`, `storage`, `network:servidor`) los declara el manifest y los aprueba el usuario **en una ventana nativa** al activar;
  si cambian se vuelve a preguntar, y la aplicación los comprueba otra vez para archivos y red. La red solo va por https y puerto 443
  a los servidores declarados, solo a direcciones públicas (se comprueba al conectar, contra el cambio de DNS), con cabeceras
  acotadas, límites de tamaño y redirecciones comprobadas una a una. Los paneles se ven sobre el reproductor (plegables, con
  recarga); lo que el plugin escriba en la consola sale en el Registro con su nombre. Ajustes ▸ Plugins enseña lo que pide cada uno,
  **crea un plugin nuevo** a partir de una plantilla que ya funciona, **empaqueta** (`.tdtplugin`, un zip reproducible con su
  SHA-256) e **instala** desde un archivo (se enseñan nombre, autor, permisos y hash antes de copiar; instalar no activa). Dos
  ejemplos en `docs/ejemplos/` (`ahora`, `tiempo`) y el recurso MCP `tdt://docs/plugins` para que una IA ayude a escribirlos.
  Probado en la aplicación real con un plugin hostil que intenta saltarse la caja; no probado en macOS ni Linux.
- **Las cabeceras de un canal se pueden modificar** (para los streams que piden cabeceras
  que no se mandaban): el botón **Cabeceras** de cualquier canal abre un diálogo para poner, cambiar y quitar cabeceras de petición (`Referer`,
  `Origin`, `User-Agent` o cualquier otra, hasta 8; ninguna por defecto, y no se puede poner `Host`, `Content-Length`, `Range` ni las del transporte).
  Valen **también para los canales de las listas públicas** (se guardan aparte, en `data/headers.json`, y sobreviven a la actualización de la lista).
  Seguridad: Origin, Referer y User-Agent van a todos los servidores del canal; **cualquier otra cabecera (una cookie, un token) va solo a los
  servidores de los enlaces del canal y se quita si el origen redirige a otro**; el valor de una credencial no vuelve a la página (se ve que está puesta);
  los valores no admiten saltos de línea. **Por MCP:** `tdt_headers_get` (nivel «leer») y `tdt_headers_set` (nivel «plugins»), que pide confirmación
  al usuario en una ventana del sistema con cada cambio a la vista (solo en la aplicación de escritorio). El detector de marcas de anuncios usa las
  mismas reglas. Prueba real en la aplicación (el diálogo, el MCP, un canal de las listas) y pruebas de Python con un origen de verdad (qué recibe y dónde).
- **Cimientos de los plugins** (fase P1 de [docs/PLUGINS-ARQUITECTURA.md](docs/PLUGINS-ARQUITECTURA.md), medida en la aplicación real):
  - **Una especificación única de la API** (`tdtlocal/static/plugin-api.json`: métodos, permisos con su riesgo, argumentos, errores,
    límites), de la que leen la página (permisos y validación de argumentos), el servidor MCP y las pruebas; otras pruebas comprueban que el
    SDK, las guías y la documentación nombran todo lo que ella dice.
  - **Errores con código** (`E_PERMISSION`, `E_INVALID`, `E_NOT_FOUND`, `E_UNSUPPORTED`, `E_UNAVAILABLE`, `E_RATE`, `E_QUOTA`) además del texto.
  - **Límite de ritmo** por plugin (ráfaga de 200 y 100 por segundo) y el SDK pone en cola las peticiones de red de más de 4.
  - **Almacenamiento con caché y escritura diferida**: `storage.set` pasa de 3,4 ms a 0,4 ms y no castiga el disco.
  - **Latido y caídas:** la aplicación pregunta a cada plugin «¿sigues ahí?» cada 5 s; pasados 15 s se marca «no responde» (con aviso en el
    panel, línea en el Registro y recarga o desactivar con un clic), y vuelve a «en marcha» solo cuando contesta. Un plugin que no arranca se
    recarga una vez. Una página que no carga el SDK no se vigila.
  - **Una pantalla que se cierra se destruye** (cada marco cuesta unos 100 MB) y se crea al abrirla.
  - **Permisos individuales:** en Ajustes ▸ Plugins cada permiso se puede quitar sin desactivar el plugin, con su riesgo a la vista; el plugin
    se reinicia sin él y esa llamada falla con `E_PERMISSION` («el usuario lo ha desactivado»).
  - **Qué hace cada plugin** (estado, llamadas, errores, reinicios, peticiones de red y a qué servidores, datos guardados) en Ajustes ▸ Plugins.
  - **Todo, usable y consultable por el MCP:** `tdt_plugins`, `tdt_plugin_logs` y `tdt_plugin_api` (nivel «leer»), `tdt_plugin_enable`,
    `tdt_plugin_disable` y `tdt_plugin_permission` (nivel «plugins»; dar poder pregunta al usuario en una ventana nativa, quitarlo no) y el
    recurso `tdt://docs/plugin-api`. Las órdenes `plugin_list` y `plugin_logs` del bus solo piden el nivel «leer».
  - **Una IA programa el plugin ella misma por MCP** (nivel «plugins»): `tdt_plugin_write` comprueba (el manifest como lo lee la aplicación,
    la sintaxis con su línea y avisos: sin SDK, `fetch()` bloqueado, permisos de más o de menos) y, si pasa, **el usuario ve los permisos con su
    riesgo y el código en una ventana nativa** y decide; escribir no activa nada, y activarlo es otra pregunta. `tdt_plugin_read` devuelve los
    archivos para cambiarlos. Un plugin activado con los mismos permisos se recarga solo; si pide otros, hay que volver a activarlo. Una
    pregunta a la vez. La guía para la IA (`tdt://docs/plugins`) explica el ciclo y lleva el plugin más pequeño que hace algo
    (`docs/ejemplos/saludo/`, comprobado por una prueba).
  - **El servidor MCP por entrada y salida estándar aguanta lo que hacen algunos clientes** (lo descubrió un cliente que daba «tiempo agotado
    a los 30 s»): `tools/list` preguntaba a la aplicación por el nivel una vez por herramienta (22 veces; con la aplicación cerrada, en Windows,
    unos 2 s cada una), y ahora lo pregunta una vez; el cliente HTTP ya no construye un contexto SSL (sin `SYSTEMROOT`, que esos clientes
    no pasan, el servidor se caía antes de contestar a `initialize`); y el registro sale en UTF-8 aunque la consola use otra página de códigos.
  - **Banco de pruebas** en `scripts/plugin-lab/` (la aplicación real, plugins que se portan mal a propósito, 55 comprobaciones con límites
    que fallan): una CPU quemada, una ráfaga, un cuelgue, una caída, una pantalla cerrada, un permiso quitado y lo que preguntaría una IA.
- **Teletexto como plugin de ejemplo** (`docs/ejemplos/teletexto/`): titulares de EL PAÍS, EL MUNDO y Europa Press, el tiempo de
  Open-Meteo y la tele ahora, en páginas numeradas (100 a 899) con subpáginas, teclas de color, doble altura y mosaicos, pintado en un
  `canvas` con la fuente Bedstead (CC0). Ocupa la pantalla del reproductor, se maneja con el ratón (botones y teclas de color en
  pantalla) y con el teclado, y no baja nada hasta que se abre. Es el decodificador del nivel 1 y la maquetación del PR de Antonio Bueno
  Martín (antoniobuen0), con la parte de datos reescrita de Python a JavaScript: pide los seis servidores con `tdt.net.fetch` y los
  declara todos en el manifest, así que quien lo active los ve en la ventana. Sin cambios en el núcleo. Probado en la aplicación real:
  los seis servidores responden y las páginas 100, 111, 200, 400 y 500 se ven y se navegan con clics y con teclas.
- **Un plugin puede ocupar la pantalla del reproductor** (`"panel": { "placement": "screen" }`): se abre sobre la imagen, también
  en pantalla completa, con un botón en la barra de controles y una cabecera de la aplicación (nombre del plugin y «Cerrar») que el
  plugin no puede quitar. La pregunta de activación lo avisa, y pasar de flotante a pantalla vuelve a preguntar. Ejemplo:
  `docs/ejemplos/pantalla/` (una pantalla de texto con el canal, la guía y canales que se eligen con un clic o con una tecla).
- **Una IA puede escribir plugins de desarrollo por el MCP** (tercer nivel del acceso, «plugins»; fase E de
  [docs/PLUGINS.md](docs/PLUGINS.md)): `tdt_dev_plugins`, `tdt_dev_read`, `tdt_dev_write`, `tdt_dev_logs` y `tdt_dev_activate`, y el
  recurso `tdt://docs/dev-plugins` con la guía. Solo en la aplicación de escritorio y con el modo desarrollador encendido (que una
  IA no puede encender). `tdt_dev_write` comprueba el resultado en una carpeta aparte y devuelve los errores (con su línea)
  sin escribir nada; si pasa, **enseña al usuario el código en un diálogo nativo** y solo si acepta lo escribe; activar es otra
  pregunta. Una pregunta a la vez, nombres y tamaños cerrados, y el Registro anota los cambios (sin el código).
- **Servidor MCP** (fase C de [docs/PLUGINS.md](docs/PLUGINS.md): lectura y control): una IA que hable el Model Context Protocol
  puede ver qué estás viendo (`tdt_state`), buscar canales (`tdt_search_channels`), ver la guía (`tdt_guide`) y las marcas de
  anuncios (`tdt_ad_markers`) y, con el nivel «leer y controlar», poner canales, cambiar de lista, el volumen, el silencio y la
  multivisión. Por entrada y salida estándar con `tdt-local mcp` (o `python -m tdtlocal.mcp`), que encuentra solo la dirección y
  el token de la aplicación abierta, o por `POST /mcp` con el token. Con el nivel «leer» solo se ven las herramientas de lectura.
  Nada devuelve direcciones de streams, las herramientas validan sus argumentos y avisan de que los nombres y títulos son datos.
  Habla las revisiones con `initialize` (2024-11-05 a 2025-11-25); la de 2026 no está implementada. Rutas de lectura con token
  nuevas: `/api/control/v1/channels`, `guide` y `markers`.
- **Bus de control** (fase B de [docs/PLUGINS.md](docs/PLUGINS.md)): una API para que una IA, un plugin o el futuro servidor
  MCP **vean y dirijan** la ventana. `GET /api/control/v1/state` da qué hay en cada casilla, el volumen y el modo (sin
  direcciones de streams); `POST /api/control/v1/command` acepta `play`, `kind`, `volume`, `mute` y `multi` y devuelve lo que
  hizo la página. **Apagado por defecto**, con dos niveles (leer; leer y controlar) en Ajustes ▸ Acceso de IAs o con
  `TDT_CONTROL_ENABLED` y `TDT_CONTROL_LEVEL`. Solo desde este equipo y con un token (`<datos>/control-token`, que la pestaña
  muestra y permite renovar); una etiqueta «IA conectada» y un registro de lo que hizo. No hay nada que toque ajustes, plugins
  ni salir. Lista cerrada de órdenes validada en el servidor y en la página.
- **Plugins de desarrollo** (aplicación de escritorio; fase 0 de [docs/PLUGINS.md](docs/PLUGINS.md)): un tipo de plugin
  **sin aislamiento ni permisos**, para quien desarrolla o para una IA que edite sus archivos. Corren con los mismos poderes
  que la aplicación, en la página de TDT local (`page`) o en el proceso principal con Node y Electrón completos (`main`),
  con recarga en caliente. Solo funcionan con el **modo desarrollador** encendido (Ajustes ▸ Desarrollo, que acaba en una
  pregunta nativa que la página no puede responder; o `TDT_DEV=1`), solo desde su carpeta propia (`<datos>/dev-plugins/`),
  cada uno activado a mano (y otra vez si cambia lo que declara), con un aviso rojo permanente en la ventana, el título y la
  bandeja. Un `page.js` con un error de sintaxis se rechaza diciendo la línea. El cargador de plugins normales rechaza sus
  manifests. Ejemplo para copiar en `docs/ejemplos/plugin-desarrollo-hola/`.
- **Reglas de automatización** («cuando pase esto, haz aquello», sin programar; guía en [docs/REGLAS.md](docs/REGLAS.md)): el botón **Reglas**
  abre un editor (JSON) con un ejemplo y la lista de lo que han hecho. Cuándo: a una hora (con días), al poner un canal o al empezar un programa
  cuyo título contenga un texto. Qué hacer: poner un canal, cambiar entre televisión y radio, volumen, silencio, multivisión y avisos; hasta 50 reglas
  de 5 acciones, y nada más: no hay código. Una regla no se repite en menos de 10 s, una misma ocasión salta una vez y lo que hace una regla no
  dispara las de canal. Se guardan en `data/rules.json` (`GET`/`POST /api/rules`; guardar solo desde este equipo). **Por MCP:** `tdt_rules_get`
  (nivel «leer») y `tdt_rules_set` (nivel «controlar»), que se comprueba antes de molestar y **se enseña al usuario en una ventana del sistema**
  con lo que cambia (solo en la aplicación de escritorio). Probado en la aplicación real (diálogo, MCP y una regla que se cumple sola) y con
  25 pruebas nuevas.
- **Una lista única de órdenes y eventos, y un bus de eventos** (base de reglas, plugins y MCP): `static/commands.json` dice qué sabe hacer
  TDT local (poner canal, volumen, silencio, multivisión, aviso) y de qué avisa; las reglas, el bus de control, los plugins y el MCP se
  **comprueban contra ella** en las pruebas (los ejemplos de cada orden los aceptan todos, y los límites coinciden), para que ya no se
  desalineen. Cuatro **eventos** nuevos: `channel.changed`, `kind.changed`, `volume.changed` y `programme.started` (en lo que se ve);
  los plugins se suscriben con `tdt.on(...)` (API 1.1, solo se añade) con el permiso `player.read` o `epg.read`, las reglas por canal ya
  escuchan el bus en vez de mirar el reproductor por su cuenta, y **lo que hace una regla se cuenta marcado (`cause: "rule"`)** y no la
  vuelve a disparar. Por MCP: `tdt_commands` (la lista) y `tdt_events` (lo último que ha pasado). Probado en la aplicación real (un plugin
  que oye el cambio de canal, un evento marcado de una regla) y con 20 pruebas nuevas; salió un fallo de orden y duplicados cuando una
  regla cambiaba algo dentro de la entrega de un evento, corregido y con prueba.
- **Ajustes generados desde el manifest** (la mayor mejora para quien hace plugins y para quien los usa): un plugin declara en `tdt.settings`
  lo que el usuario puede elegir (`boolean`, `number` con límites, `string` con longitud máxima, `choice` con opciones; hasta 20) y **la
  aplicación dibuja el formulario** en Ajustes ▸ Plugins, lo valida y lo guarda: el plugin no dibuja nada y **solo lee** el resultado con
  `tdt.config.get('nombre')` / `tdt.config.all()` (sin permisos; API 1.1) y se entera de los cambios con `tdt.on('config.changed')`. Un ajuste mal
  declarado impide activar el plugin y dice por qué; un valor guardado que ya no vale cae al de por defecto. **Por MCP:** `tdt_plugins`
  cuenta los ajustes y su valor, y `tdt_plugin_config` los cambia (se comprueba antes de molestar y el usuario ve cada cambio en una
  ventana del sistema). Probado en la aplicación real (un plugin que lee y se entera, un cambio por MCP) y con 22 pruebas nuevas.
- **Servicios que duermen hasta su momento** (activación por eventos y por hora): un plugin **sin panel** declara en `tdt.activation` cuándo hace
  falta (`onEvent:channel.changed`…, `onTime:21:30`, `onStartup`) y **no tiene proceso mientras espera** (cada marco cuesta unos 100 MB). Lo despierta
  el evento que pidió (si tiene el permiso que ese evento exige) o la hora, y **le llega el evento que lo despertó**; con un minuto sin llamadas
  ni eventos vuelve a dormir y se libera el proceso. Se ve «dormido, a la espera de su momento» con las veces que se despertó, en Ajustes y por MCP
  (`tdt_plugins`). Evento nuevo `schedule` (API 1.1). Con un panel no vale: el manifest da el error. Probado en la aplicación real (dormido sin
  marco, despierta en 0,5 s con el evento, duerme a los 63 s y despierta otra vez) y con 5 pruebas nuevas. Salió una prueba de salud de la
  aplicación que falló una vez por la ventana oculta (el latido no pregunta a una ventana oculta, a propósito) y pasó entera al repetir.
- **Fuentes de reproducción que añade un plugin** (primer paso de sacar YouTube, Twitch y Atresplayer del núcleo): un plugin declara en
  `tdt.sources` una dirección con huecos (`https://www.twitch.tv/{1}`) y el reproductor incrustable que enseñar para ella
  (`https://player.twitch.tv/?channel={1}&parent={parent}`), **sin código**: la página solo rellena una dirección. Hace falta el permiso nuevo
  **`embed:servidor`** (sin comodines, **riesgo crítico**, con su aviso: una página de ese servidor corre en la ventana del usuario). La
  política de la página **solo deja enmarcar los servidores aprobados de los plugins que están activos** y la fuente desaparece si el usuario
  quita el permiso. Los huecos solo toman letras, números y `_.~-`, nunca el servidor, y el servidor del reproductor se comprueba otra vez
  al pintar. Un canal propio con un enlace de Twitch se reproduce así. Probado en la aplicación real (la política, el marco con la
  dirección correcta y el permiso quitado) y con 14 pruebas nuevas. YouTube y Atresplayer no se han movido todavía: siguen en el núcleo. **Comprobado con un canal de Twitch en directo en la
  aplicación real: el reproductor carga dentro de la casilla (acepta `parent=127.0.0.1`) y, con un clic en su botón de play, el vídeo arranca
  (1920 px, avanzando); no arranca solo ni con `autoplay=true&muted=true`**, y la casilla lo dice.
- **Proveedores de canales: un plugin puede aportar canales a la lista** (`tdt.channels.provide`, permiso nuevo `provide:channels`, riesgo alto): un
  plugin (normalmente con `network:` para leer una lista de otro sitio) entrega hasta 500 canales `{name, sources, logo, web, kind, category, group,
  epg}` que **sustituyen** a los que aportaba antes. El servidor los valida todos o ninguno (`tdtlocal/providers.py`): solo enlaces `http(s)`,
  **sin cabeceras ni ids propios** (el id es `prov-<plugin>-<nombre>`, así no se puede pisar un canal de las listas ni del usuario), hasta 10
  plugins a la vez, y se guardan en `data/providers.json` para que estén al arrancar aunque el plugin duerma. Salen con la categoría «Plugin ·
  id» salvo que pongan otra, y **se van solos si el plugin se apaga o el usuario le quita el permiso**. Rutas `GET`/`POST /api/providers` (cambiar,
  solo desde este equipo). Probado en la aplicación real (los canales llegan en 0,5 s, un canal con cabeceras se rechaza con `E_INVALID`, y se van
  al quitar el permiso o apagar el plugin) y con 10 pruebas nuevas. **Falta** la guía (EPG) como proveedor, y no he probado la limpieza de un
  proveedor que desapareció con la aplicación cerrada (el código está, la prueba no).
- **Proveedores de guía: un plugin puede aportar la programación de sus canales** (`tdt.epg.provide`, permiso nuevo `provide:epg`, riesgo medio): entrega
  `{canal: [[inicio, fin, título, descripción?, categoría?], ...]}` (segundos desde 1970, hasta 500 canales y 60 programas de hasta 24 h; lo que ya
  terminó se descarta) que **sustituye** a la guía que aportaba. Se valida todo o nada y queda bajo **`plugin:canal`**: **nunca puede sustituir la guía de un
  canal de las listas**; un canal que aporte con `tdt.channels.provide` la usa poniendo `epg: 'plugin:canal'`. Vive en memoria (el plugin la vuelve a
  entregar al arrancar) y se quita si el plugin se apaga o pierde el permiso, dejando los canales. `POST /api/providers/epg`; `GET /api/providers`
  cuenta canales y guías. Probado en la aplicación real (la lista enseña el programa del plugin, la guía se va al quitar `provide:epg` y los canales
  se quedan) y con 6 pruebas nuevas.
- **Reglas y atajos que trae un plugin** (`tdt.rules`) **y disparador por tecla**: las reglas ganan `when: {type: "key", key: "Alt+1"}` (siempre con Ctrl
  o Alt, más una letra, un número o F1-F12; no salta mientras escribes ni con un diálogo abierto), y un plugin puede traer hasta 10 reglas en su manifest.
  **Salen apagadas** en el diálogo *Reglas* («Reglas que traen los plugins», con su frase y una casilla) y **las enciende el usuario**: lo que el plugin
  ponga en `enabled` no cuenta y la elección se conserva aunque el plugin se reinicie; se quitan solas si el plugin se apaga. El servidor las valida como las
  del usuario (`POST /api/rules/plugin`, `POST /api/rules/plugin/enable`, solo desde este equipo) y `tdt_rules_get` las lista. Probado en la aplicación real
  (la regla sale apagada, Alt+9 no hace nada hasta encenderla, luego baja el volumen, y se va con el plugin) y con 14 pruebas nuevas. En una pasada del banco
  fallaron cuatro comprobaciones de secciones anteriores que dependen de cuándo llega la lista pública de internet; en la repetición pasaron las 135.
- **Temas que trae un plugin** (`tdt.themes`, hasta 5): un nombre y los colores de las variables de la página, **sin CSS ni código**. Solo se pueden cambiar doce
  variables (`--chassis`, `--panel`, `--ink`, `--muted`, `--line`, `--screen`, `--accent`, `--accent-ink`, `--row-hover`, `--ok`, `--bad`, `--unk`; ni tipografías
  ni tamaños) y con **colores simples** (`#hex`, `rgb()`, `hsl()`: `url()`, `var()` y `calc()` se descartan). **No se aplica solo**: sale en Ajustes ▸ Plugins ▸ «Tema de la
  aplicación» y lo elige el usuario (se guarda en el navegador); si el plugin se apaga, la página vuelve a sus colores. Probado en la aplicación real (el color
  cambia al elegirlo, la tipografía y una dirección colada no, y vuelve al apagar el plugin) y con 6 pruebas nuevas. Los temas se ven en `tdt_plugins`.
- **Adaptadores de control para las fuentes de plugin** (`control` en `tdt.sources`): una fuente puede pedir `"youtube"` (solo con `www.youtube-nocookie.com` o
  `www.youtube.com`) o `"atres"` (solo `www.atresplayer.com`) y el núcleo silencia y devuelve el sonido de ese reproductor como el de los integrados (en
  multivisión ya no suenan juntos). El plugin no escribe código; la tabla de adaptadores y sus servidores está en el lector del manifest y se vuelve a comprobar
  en la página, de modo que un emparejamiento raro no recibe órdenes. Las órdenes de YouTube ahora van al servidor del propio marco. Probado con YouTube real
  en la aplicación (el `<video>` pasa a silenciado y vuelve desde TDT local, con un directo avanzando) y con 3 pruebas nuevas. **Es el primer paso para mover YouTube y
  Atresplayer a plugins; siguen integrados** (modo navegador sin plugins).
- **Corregido: un servicio que duerme se mantenía despierto por eventos que no había pedido.** Al despertarlo, la página emitía otro `volume.changed` y cada
  evento reenviado reiniciaba su temporizador de ocio, así que tardaba el doble en dormir o no dormía. Ahora solo alargan su vida sus propias llamadas y los eventos
  de su `activation`. El banco de pruebas, sensible a la ventana (visible, con foco), ahora la trae al frente y simula el foco; sigue necesitando un escritorio libre.
- **Inspector en vivo** (Ajustes ▸ Plugins ▸ Inspector) **y `tdt_plugin_calls`**: una línea de tiempo con los **eventos** de la aplicación, las **llamadas de los plugins** (plugin, método,
  `ok` o el código de error y los milisegundos; **nunca argumentos ni respuestas**, que pueden llevar lo que ves) y lo que hacen las **reglas**; con filtro por tipo y por texto, pausa
  y refresco mientras está abierto. La página guarda las últimas 300 llamadas (`E_PERMISSION`, `E_RATE` y `E_QUOTA` incluidos) y una IA las lee por MCP con `tdt_plugin_calls`
  (nivel «leer», filtrable por plugin). Probado en la aplicación real (un plugin llama a `player.state` y a `player.play` sin permiso: sale `ok` y `E_PERMISSION`, en el MCP y en el diálogo) y con 9 pruebas nuevas.
- **Las siglas TDT ahora significan «Tune · Display · Tinker»** (en inglés, siempre): el nombre sigue siendo **TDT local** y sigue guiñando a la TDT de toda la vida, pero el lema cuenta lo que hace
  (sintonizar, mostrar y dejar trastear, todo en local). Sale en el README, en «Créditos y licencias», como texto de ayuda del título de la ventana, en las descripciones de
  los paquetes y de los instaladores y en la presentación que el MCP da a las IAs. **No cambia ningún identificador** (`tdt-local`, `tdt.*`, `tdt_*`, `.tdtplugin`): sin migración.
- **Instalar un plugin desde un enlace o desde un catálogo** (Ajustes ▸ Plugins ▸ Instalar desde internet): pegas un enlace `https` a un `.tdtplugin` (con el SHA-256
  de su autor, opcional) o la dirección de un catálogo (`index.json` con `id`, `name`, `url` y **`sha256` obligatorios** por plugin) y ves la lista con Instalar,
  Actualizar o Instalado. Nada se descarga hasta que lo pides; el enlace tiene que ser https, puerto 443, sin usuario y de **un nombre público**, la conexión solo va a direcciones públicas
  (se comprueba al conectar), con hasta 3 redirecciones comprobadas, 16 MB por plugin y 1 MB por catálogo. Un archivo que no coincide con el hash esperado se rechaza **antes** de enseñarte
  nada. Se te hace **la misma pregunta que con un archivo** (nombre, autor, versión, de qué servidor viene, permisos leídos del paquete, SHA-256) y **instalar no activa**. **Una IA no puede
  instalar**: es decisión tuya. Probado en la aplicación real con un catálogo de prueba (lectura, hash distinto rechazado, enlace sin https o a una IP rechazado, instalación con el hash del
  catálogo, el Registro dice de dónde vino) y con 6 pruebas nuevas; la descarga por internet de verdad se comprobó con un archivo de GitHub (llega, un 404 se explica y el límite de tamaño corta).
  **Sin probar:** una descarga de un paquete `.tdtplugin` real por internet de punta a punta (el banco usa una carpeta en lugar de la red), y `tdtchannels.com` dio `ETIMEDOUT` desde Node en esta
  máquina aunque Python lo alcanza (sin explicar). **Faltan las firmas de autor** y actualizar con diferencias a la vista.
- **Firmas de autor para los plugins** (ed25519): `scripts/plugin-sign.mjs keygen|sign|verify` crea una clave (con su **huella** de 32 cifras), firma el SHA-256 de un `.tdtplugin` y escribe un `.sig`; sin
  red. Al instalar (de un archivo con su `.sig` al lado, de un enlace —se busca `dirección.sig`— o de un catálogo con `signature`) la app **comprueba la firma** y lo cuenta en la pregunta:
  *firma con la misma clave de siempre*, *clave nueva (primera vez para este plugin: compara la huella)*, y **avisos** (⚠) para *la clave ha cambiado* y *sin firma en un plugin que venía firmado*. Una firma
  que no corresponde al archivo se **rechaza sin preguntar**. No hay autoridad: es confianza en el primer uso, y la app recuerda con qué clave se instaló cada plugin (`plugin-keys.json`). El catálogo enseña la
  huella de cada entrada. Probado en la aplicación real (clave nueva, la misma otra vez, otra clave, sin firma, firma de otro archivo rechazada y el Registro) y con 8 pruebas nuevas, incluida la herramienta del autor.
  **Una comprobación del banco falló dos veces** («y le devuelve el sonido», el YouTube real servido por un plugin; en aislado funciona) y pasó a la primera orden después: la he hecho tolerante a hasta tres intentos y
  muestra cuántos hacen falta. Sin probar: una clave perdida o robada y su sustitución de punta a punta.
- **Límites de memoria y procesador por plugin**: la aplicación atribuye cada proceso a su plugin (`osProcessId` de cada marco más `getAppMetrics`, **comprobado en la aplicación real**) y mira los procesos
  cada 5 s. **Para el marco** de un plugin que usa más de **300 MB** (en dos miradas seguidas) o más del **80 % de un procesador durante 20 s sin respiro**; el Registro, Ajustes ▸ Plugins (⚠ «parado por pasarse
  de memoria o procesador»), el Inspector y el MCP (`state: over-limit`, `overLimit`) lo cuentan, y **⟳ Recargar** lo arranca otra vez. El estado enseña ahora la memoria y el procesador de cada plugin. Un proceso
  que comparte plugin o página con otro no se le achaca a ninguno. Dos cosas que salieron al probar en la aplicación real: **Electron da el procesador como parte de todos los núcleos** (un bucle que llena un núcleo de 32
  sale como 3,1 %; se multiplica por los núcleos) y **al recargar un plugin parado Chromium reutiliza el mismo proceso, que sigue con su memoria**, así que sin cambios se volvía a parar cada 3 s: ahora, tras una parada,
  solo cuenta lo que **crece** respecto a lo que el proceso ya tenía (y hasta lo más bajo que haya llegado a tener). **Limitación:** lo que vuelve a reservar un plugin reiniciado dentro de esa memoria retenida no se distingue
  midiendo el proceso hasta que éste la devuelve. Probado en la aplicación real (se mide, para un plugin que come 500 MB en unos 4 s y otro que quema el procesador en unos 30 s, el Registro y el MCP lo cuentan,
  recargar lo arranca sin bucle, los demás siguen) y con 10 pruebas nuevas. En el banco los topes se bajan con `TDT_LIMIT_*`; en una aplicación instalada se ignoran. En una pasada del banco con vigilancia cada 2 s fallaron
  de golpe las secciones 16 a 19 y no se repitió (con 5 s y con 2 s volvieron a pasar): sin explicar.
- **Modo seguro: la aplicación arranca sin que corra ningún plugin.** Entra **sola** si se ha cerrado mal las dos últimas veces seguidas que arrancó (la caída o la muerte del proceso se detecta con un marcador que
  se quita al cerrar bien) y **a mano** con `--safe`, `TDT_SAFE_MODE=1`, el botón *Reiniciar en modo seguro* de Ajustes ▸ Plugins o el menú de la bandeja. En modo seguro no corre ningún plugin (ni los tuyos, ni los de
  desarrollo, ni los incluidos), el título dice «MODO SEGURO» y un aviso con el motivo trae el botón **Salir del modo seguro**. **No se pierde nada**: lo activado y sus permisos siguen en sus archivos y no se
  tocan (no se puede activar ni apagar nada mientras dura, tampoco por MCP, que lo rechaza diciendo por qué; las lecturas siguen). Un cierre limpio no cuenta. Probado en la aplicación real, con arranques y cierres de verdad
  (`scripts/plugin-lab/safe-mode.mjs`, 15 comprobaciones): un cierre malo sigue siendo normal, dos seguidos entran, uno limpio entre medias no suma, el título nativo lo dice y salir devuelve el plugin; y con 3 pruebas
  nuevas del marcador y la decisión. **Límite:** solo detecta que la aplicación muere, no un plugin que rompe nada más que su página; para ése están los límites de memoria y procesador y el botón manual.
- **Lanzador de escritorio para Windows:** `iniciar-escritorio.bat` abre la aplicación de escritorio con doble clic (instala sus
  dependencias la primera vez).

### Cambios
- **Revisión general antes de publicar:** el MCP se parte en `mcp.py` (el protocolo y los dos accesos a la aplicación) y
  `mcp_tools.py` (el catálogo de herramientas y la comprobación de sus argumentos); las órdenes del bus de control pasan de una
  cadena de `if` a una tabla (`CLEANERS`) con un comprobador pequeño por orden; en `desktop/main.js` las tres ventanas que solo
  enseñan su sitio comparten una función (`keepInside`), el interruptor de las pruebas está en un solo sitio y una dirección que
  no se puede leer ya no rompe un manejador de eventos. El proxy suelta la respuesta de un origen que contesta con error y las
  marcas de orden de bytes del código se escriben como `﻿`, a la vista. Sin cambios de comportamiento: 542 pruebas de Python,
  263 del navegador y las 71 comprobaciones de la aplicación real.

### Seguridad
- **El proxy se conecta a la dirección que comprobó:** antes resolvía el nombre del servidor para comprobar que era público y
  `urllib` lo volvía a resolver al conectar, así que un servidor que contestara una dirección pública y un momento después una privada
  (rebinding de DNS) podía alcanzar el equipo o la red local. Ahora la conexión usa solo las direcciones ya comprobadas (con una caché
  de 30 s). Detrás de un proxy del sistema se mantiene lo de antes, porque es el proxy quien conecta. Con pruebas del cambio de DNS y
  comprobado contra servidores reales.
- **`custom.json` y `headers.json`** (pueden llevar una cookie o un token) se escriben con permisos solo para el usuario desde el
  primer instante (en Windows el modo se ignora: la carpeta del usuario ya es privada).
- **La lista de U7D** ya no se lee sin límite (4 MB como mucho) y **una guía XML en UTF-16 ya no puede esconder una declaración de
  entidades** al control de «billion laughs».

## [1.3.0] — 2026-11-01

**Los instaladores llevan ahora la aplicación de escritorio** (ventana propia, bandeja y plugins) en lugar de abrir tu
navegador. Pesan del orden de cien megas, no diez.

### Funciones
- **Los instaladores llevan la aplicación de Electrón** (Windows, macOS y Linux): `packaging/build.py` congela el
  servidor, empaqueta la app y la convierte en el `setup.exe` y el `.zip`, el `.dmg` y el `.deb` y el `.tar.gz`. El
  instalador de Windows mantiene su identidad y limpia la carpeta `_internal` de la versión anterior, así que actualiza
  encima, y los datos son los mismos. Piden **macOS 13 o superior** (lo exige Electrón 44 y posteriores) y, el `.deb`,
  glibc 2.35. En Linux, el `.deb` deja `chrome-sandbox` con los permisos que pide Chromium y el `install.sh` del
  `.tar.gz` crea un lanzador que usa `--no-sandbox` solo si el sistema no permite otra forma de aislamiento.
  `python packaging/build.py --classic` construye aún la aplicación de antes (solo el servidor y tu navegador).
- **Servidor congelado para la aplicación** (`python packaging/build.py --server-only`; `packaging/server.py` y
  `packaging/tdt-local-server.spec`): el servidor solo, con PyInstaller, que la app lleva dentro en lugar de usar el
  Python del sistema. En desarrollo, `TDT_SERVER_EXE` lo usa para probar ese camino.
- **La aplicación se puede empaquetar** (`npm run pack` en `desktop/`, con `@electron/packager`): el ejecutable
  `tdt-local`, el servidor congelado, los plugins que vienen con ella y el icono, sin los idiomas de Chromium que no se
  usan.
- **`packaging/smoke.py`**, una prueba de humo de la app empaquetada (arranca, sirve la página, un segundo lanzamiento
  cede el paso y al salir se cierra todo), que la CI pasa en los tres sistemas y, en Linux, también sobre el `.deb`
  instalado.

### Correcciones
- **El bus de control perdía una orden que llegaba mientras la página se recargaba.** El servidor tardaba hasta 15 s en darse
  cuenta de que la página había cerrado su conexión y la orden se quedaba en esa conexión «fantasma» hasta dar error a los
  20 s. Ahora nota el cierre en medio segundo y, si una orden se queda sin ninguna página que la tenga, se la entrega a la que
  se conecte (sin repetirla si otra la tiene). Con pruebas, y comprobado contra la aplicación real.
- **Aplicación de escritorio: se perdían favoritos, último canal y volumen al cerrarla.** Cada arranque elegía un puerto
  distinto y la página guarda esas preferencias por origen (que incluye el puerto). Ahora la app recuerda el último
  puerto, lo pide primero y luego prueba del 8790 al 8799; solo si todos están ocupados usa otro (y lo anota en el
  Registro). Lo que había en tu navegador no pasa: es de otro perfil.
- **El servidor no se cerraba al pedírselo mientras se exploraban marcas de anuncios o se comprobaban canales.** Los hilos
  de esos dos recorridos mantienen vivo el proceso hasta vaciar su cola (cientos de canales con hasta 8 s de espera cada
  uno), así que «Salir» o cerrar la ventana acababa a la fuerza tras 5 s, sin guardar el estado. Ahora, al cerrar, lo que
  queda en cola se salta y el servidor sale solo (código 0) en un par de segundos. Con dos pruebas nuevas.

### Cambios
- Lo que guarda Electrón (almacenamiento de la página, estado de los plugins, registro) pasa a la subcarpeta `desktop/`
  de la carpeta de datos de TDT local, la misma que usa el servidor, en lugar de `%APPDATA%\tdt-local-desktop`. El
  estado de los plugins se copia solo la primera vez; la respuesta al aviso de cookies de Atresplayer no.

## [1.2.0] — 2026-11-01

Primer prototipo de la aplicación de escritorio con ventana propia y plugins, más U7D («últimos 7 días») y el Registro.

### Funciones
- **Aplicación de escritorio con Electrón y plugins** (prototipo en `desktop/`; **solo desde el código**, los instaladores de esta versión siguen siendo los de siempre). Una ventana propia con Chromium integrado que arranca el servidor de Python, un icono en la bandeja y un sistema de plugins: carpetas con un `manifest.json` (el formato `content_scripts` de las extensiones de Chrome) cuyos scripts se ejecutan en las páginas que declaran. Todos empiezan desactivados y se rechazan los que piden permisos, `background` o patrones demasiado anchos. Se gestionan en Ajustes ▸ Plugins, que solo existe en esta app. Es la misma base de código que el modo navegador, que sigue funcionando igual. Detalle y límites en [docs/DESKTOP.md](docs/DESKTOP.md).
- **U7D («últimos 7 días»)**: un tercer botón junto a Televisión y Radio con los canales de RTVE que tienen
  grabaciones (La 1, La 2, 24 Horas, Teledeporte y Clan). Dentro de cada uno, lo emitido en la última semana del más
  reciente al más antiguo, con miniatura y buscador; un programa se reproduce como un canal (vista simple o casilla
  de la multivisión). Rutas `/api/u7d` y `/api/u7d/play`; el listado se guarda diez minutos. Los programas con DRM se
  rechazan con un mensaje claro. Las miniaturas pasan por la caché de logos con su propio tope de 3 MB. Idea y primera
  versión de m4rt0s (su rama `feat/u7d`); aquí se ha reducido a RTVE porque la parte de Atresplayer y Mediaset se
  apoya en imitar la web de cada cadena.
- **U7D de Atresmedia en la aplicación de escritorio**: Antena 3, laSexta, Neox, Nova, Mega y Atreseries. Al entrar en
  uno, una ventana «Explorar Atresplayer» (con sus propios datos de navegación, solo puede ir a `atresplayer.com`)
  abre la página pública «Emitido en TV» del canal, el plugin nuevo `tools/atresplayer-u7d` lee los programas que
  muestra y la ventana se cierra sola. El reproductor incrustado de Atresplayer no reproduce estas grabaciones (su
  petición `player/v1/video/<id>` responde 404), así que cada programa abre su página de Atresplayer en una ventana de
  la aplicación (con los mismos datos que la de exploración; «Abrir en tu navegador» como alternativa). Atresplayer
  no reproduce si detecta que sus anuncios no cargan (por ejemplo, con un DNS que los filtra): la reproducción
  real no está comprobada en el equipo de pruebas. Hace falta activar el plugin. La aplicación comprueba quién envía lo leído y
  limpia cada campo. Nueva ruta `/api/u7d/covers` (solo miniaturas de `imagenes.atresplayer.com`, hasta 300).
  El puente de Atresplayer actúa también en `/embed/video/*` (sin probar con anuncios reales).
- **Registro de la aplicación de escritorio** (Ajustes ▸ Registro): arranque, plugins, ventana de exploración, salida
  del servidor, errores de la página y de los reproductores de dentro y fallos de red (una vez por dirección y sin
  parámetros). Se puede filtrar, copiar, guardar en un archivo y abrir su carpeta; también se guarda en
  `logs/tdt-local.log` (1 MB y un archivo anterior). Oculta claves, tokens y cabeceras de credenciales.

### Correcciones
- El servidor rechazaba conexiones cuando una página pedía decenas de archivos a la vez: la cola de espera del socket era la de Python (5). En Windows se veía como una página sin canales al abrir la aplicación, de forma intermitente. Ahora la cola es de 128 y hay una prueba con 100 conexiones simultáneas. La aplicación de escritorio, además, recarga la página (como mucho dos veces) si ve que su servidor rechaza una conexión, y lo anota en el Registro.

### Documentación
- [docs/DESKTOP.md](docs/DESKTOP.md): estado del prototipo, cómo probarlo, formato de los plugins y qué falta (empaquetado, actualizaciones). Capturas de pantalla de la aplicación en [docs/img](docs/img).

### Versiones
- Los plugins `puente-atresplayer` y `atresplayer-u7d` pasan a la 1.2.0. El puente actúa también en `/embed/video/*`.

## [1.1.0] — 2026-11-01

Marcas de anuncios, reacciones a la publicidad, sonido (igualador y ecualizador) y Atresmedia con un clic.

### Correcciones
- Una petición `POST` rechazada (403) descarta ahora su cuerpo antes de responder, para que el cliente reciba el 403 en
  vez de un reinicio de conexión (visto en Windows).

### Funciones
- **Guía de la extensión del puente** en `tools/puente-atresplayer/LEEME.md`: para qué sirve, qué hace y qué no (sin
  permisos, solo dentro del reproductor, sin peticiones), instalación paso a paso, cómo comprobarla, problemas
  frecuentes, protocolo de mensajes y mantenimiento. El `manifest.json` pasa a la versión 1.1.0, la de TDT local.
- **Igualador de volumen y ecualizador en el reproductor de Atresplayer**: el puente (instalado como extensión) lleva
  ahora `audio-chain.js`, la cadena de sonido de la página generada con `scripts/build_bridge.py`, y la aplica dentro del
  reproductor con los ajustes del canal que le manda TDT local; el diálogo «Sonido» muestra la medida. Con solo el script
  pegado no hay procesado de sonido.
- **El anuncio de arranque del reproductor de Atresplayer no cambia de canal**: el que llega con menos de 20 s de programa
  seguidos antes (al pulsar «Directo» o cuando el reproductor se reinicia tras una pausa) solo silencia y avisa. Evita el
  bucle «Directo → anuncio → cambio de canal → volver → Directo». El puente cuenta ahora también si el reproductor emite.
- **Un canal, varias fuentes** al añadir canales propios: si ya existe uno con el mismo nombre, el enlace (o el reproductor
  de Atresplayer del botón «Atresmedia») se añade como otra fuente suya en vez de crear una copia. El reproductor incrustado
  va siempre después de los streams y no se recuerda como favorito, así que se prueba primero el stream y, si falla, el
  reproductor oficial. La API acepta `merge: true` en `/api/custom`.
- **El puente reconoce también el aviso de las pausas del directo** («El canal que estás viendo en directo se encuentra
  en estos momentos en publicidad»), además del «Publicidad» corto del anuncio previo; y dice en la consola qué texto vio.
- **Guía extra (XMLTV comunitario) e iconos para los canales de Atresmedia**: nuevos ajustes `epg_extra_enabled` y
  `epg_extra_source` (Listas y guía). Lee de una guía comunitaria solo los canales propios cuyo identificador no está en las
  guías de las listas, con ETag, cada 6 h como mucho y sin guardar el resto; el botón de Atresmedia la activa y da a esos
  canales su identificador y su icono. Volver a pulsarlo completa los canales ya añadidos.
- **Cambiar de canal durante la publicidad ya no destruye el original**: en vista simple el canal original sigue en otra
  casilla, fuera de la vista y silenciado. Así se ve cuándo acaba la pausa (marca de fin, o el aviso del puente de
  Atresplayer), se vuelve al instante y no se recarga, lo que arrancaba otro anuncio y otro cambio. En multivisión, un anuncio
  en los 90 s siguientes a volver a cargar un canal ya no provoca otro cambio.
- **Aviso fijo «PUBLICIDAD»** sobre la imagen mientras dura una pausa (opción nueva en «Durante la publicidad»), y
  **puente con el reproductor de Atresplayer**: `tools/puente-atresplayer`, una extensión (o script de usuario) que lee dentro
  del reproductor incrustado el aviso «Publicidad» y se lo cuenta a TDT local, que así puede avisar, reaccionar y silenciar
  el sonido (también con `M`). Sin el script nada cambia. La reacción ya no exige la vigilancia de marcas.
- **Atresmedia con un clic**: «Añadir canal» añade los canales de Atresmedia con el reproductor oficial incrustable de
  Atresplayer en una casilla (como YouTube; `frame-src` admite `https://www.atresplayer.com`; en multivisión solo se
  puede silenciar con el script del puente).
  Mediaset no se ofrece: Mediaset Infinity no permite incrustarse y sus canales ya están en las listas como «solo web».
  Un canal propio puede no tener enlace de stream si tiene web, y los canales propios se listan siempre.
- **Quitar canales propios desde la lista**: una ✕ en cada fila de canal propio, con confirmación; si el canal estaba en
  una casilla, esta se vacía.
  El aviso de «no se pudo reproducir» muestra ahora el código HTTP que devolvió el origen.
- **Sacar el enlace de un directo desde tu navegador**: `tools/capturar-directo.js`, un fragmento para la consola que
  toma de lo que ya se está reproduciendo la lista `.m3u8` y abre TDT local con el diálogo «Añadir canal» relleno
  (`#add=…`, solo rellena; el fragmento no sale del equipo y se borra de la barra de direcciones).
- **Marcas de anuncios (SCTE-35)**: vigilancia opcional que detecta, avisa y guarda en `data/scte.jsonl` las marcas de
  publicidad de los streams HLS (`CUE-OUT/IN`, `DATERANGE`, `OATCLS`…), decodifica el mensaje binario, y puede mirar
  también el PID SCTE-35 del MPEG-TS y los eventos `emsg`. Nueva pestaña en Ajustes, botón **Marcas** con el registro
  (descargable en JSON/CSV) y rutas `/api/scte*`.
- **Sonido**: igualador de volumen (sube lo bajo y baja lo alto hasta un nivel elegido, con tope de subida y limitador)
  y ecualizador de 10 bandas con preajustes, con ajustes globales y propios de cada canal. Cadena Web Audio por casilla,
  sin tocar el volumen ni el silencio existentes; el diálogo **Sonido** muestra la medida en vivo.
- **Durante la publicidad**: nueva pestaña en Ajustes para que la página reaccione cuando el canal que se ve entra en una
  pausa de anuncios: silenciar o bajar el sonido, cambiar a otro canal o mostrar una web sobre la imagen, volviendo al
  llegar la marca de fin o al pasar la duración. Respeta (o deshace, a elegir) lo que se toque durante la pausa. Nueva
  comprobación de que la web se puede mostrar (`/api/settings/test/web`); solo esa web se añade a `frame-src`.

## [1.0.0] — 2026-10-30

Primera versión publicable.

### Funciones
- Visor de la TDT española con las listas de TDTChannels y proxy HLS local.
- Radio (unas 980 emisoras) con reproducción directa o HLS.
- Comprobación de streams, favoritos y filtros.
- Multivisión de cuatro canales con rotación del audio.
- Guía de programación (XMLTV) con «ahora / después».
- Canales de YouTube incrustados y canales propios con cabeceras `Origin`/`Referer`.
- Asistente de IA local (API de chat compatible con OpenAI), con el razonamiento desactivado.
- Subtítulos en directo y alertas por voz con whisper.cpp.

### Ajustes
- Pantalla **Ajustes** con tres pestañas: asistente de IA (dirección, modelo, clave de API, temperatura, tokens,
  tiempo de espera, razonamiento y parámetros extra), subtítulos (idioma, modelo, carpeta de modelos, programa
  y servidor de Whisper, hilos, inactividad) y listas y guía (frecuencia, comprobación automática, guía y fuentes).
- Todo es persistente (`settings.json`) y se aplica sin reiniciar; lo fijado por flag o variable `TDT_<AJUSTE>` manda
  y se muestra bloqueado.
- Catálogo de modelos de Whisper con descarga (progreso, cancelación, comprobación de espacio y verificación
  SHA-256), «Probar conexión» del asistente y «Comprobar» de Whisper.
- Los ajustes solo se pueden cambiar desde el propio equipo, también con `--lan`.

### Distribución
- Instaladores para Windows (`.exe` y `.zip` portable), macOS (`.dmg`) y Linux (`.deb` y `.tar.gz`), con su propio Python.
- Aplicación de escritorio sin consola: datos por usuario, botón «Salir» y una sola instancia.
- Licencia Apache 2.0 con `NOTICE` y página «Créditos y licencias» (cita de TDTChannels, hls.js y el resto).
- Certificados TLS de reserva (sistema o certifi) para las aplicaciones empaquetadas.

### Calidad
- Reorganizado como paquete de Python (`tdtlocal/`) sin estado global, con instalación por
  `pyproject.toml` y `python -m tdtlocal`.
- Interfaz dividida en módulos ES; la lógica pura está en `static/js/lib/`.
- 252 pruebas de Python y 22 del navegador; CI en GitHub Actions; lint con ruff.
- Corregido: una respuesta del modelo que no era JSON devolvía «400 pregunta vacía» en lugar de un
  error de pasarela con un mensaje claro.
- Corregido: «pon el toro» no encontraba «El Toro TV».
- Corregido: tras reiniciar el servidor, los subtítulos de una casilla no se reanudaban.
- Mejorado: `/api/channels` ya no se retrasa varios segundos si Whisper no está en marcha.
- Los canales propios ya no pueden reutilizar el identificador de un canal de las listas.
- Los lanzadores ya no dependen de rutas personales: usan `iniciar.local.*` o variables `TDT_*`.
