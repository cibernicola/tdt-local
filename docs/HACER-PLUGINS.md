# Hacer plugins para TDT local

Esta guía es para quien quiera **hacer un plugin y compartirlo**, sin haber tocado nunca el código de TDT local. Los plugins
solo existen en la aplicación de escritorio (la versión de navegador no los carga). Si buscas el diseño y las decisiones de
fondo, está en [PLUGINS.md](PLUGINS.md); aquí solo está lo que hace falta para hacer uno.

Ejemplos que funcionan, para copiar: [`ejemplos/ahora/`](ejemplos/ahora/) (qué estás viendo y qué dan ahora, con botones de
volumen), [`ejemplos/tiempo/`](ejemplos/tiempo/) (la temperatura de una ciudad, hablando con internet),
[`ejemplos/pantalla/`](ejemplos/pantalla/) (una pantalla de texto sobre el reproductor) y
[`ejemplos/teletexto/`](ejemplos/teletexto/) (un teletexto completo: red con varios servidores, almacenamiento, la guía, un canvas, una
fuente propia y pantalla a todo el reproductor; es el más grande y el que mejor enseña cómo se estructura un plugin de verdad).

## 1. Qué clase de plugin quieres

| Clase | Para qué | Cómo corre | Qué puede | Guía |
|---|---|---|---|---|
| **Con permisos** (`tdt.api: 1`) | Un panel propio, un aviso, algo que mire o maneje el reproductor, consultar un servidor | Aislado, en su propio marco, sin acceso a nada que no declare | Solo lo que pide en `permissions` y tú apruebas al activarlo | **Esta guía** |
| **Con todo el poder** (`tdt.full`) | Cambiar lo que hace la aplicación (la publicidad, capas sobre la imagen, teclas…), o un **tema** que cambia todo el aspecto | Dentro de la página, **sin aislar**, con los ganchos de la aplicación | Casi todo; la aprobación es de su código y se enseña al activarlo | [Más abajo](#plugins-con-todo-el-poder-y-temas) y [HACKEABLE.md](HACKEABLE.md), [TEMAS.md](TEMAS.md) |
| **De scripts** (`content_scripts`) | Cambiar el reproductor incrustado de una web de un canal | Sus scripts corren dentro de las páginas que declara | Tocar esa página y nada más | [PLUGINS.md](PLUGINS.md) y `tools/puente-atresplayer/` |
| **De desarrollo** (`tdt.dev`) | Probar cosas con acceso total, o dejar que una IA pruebe | **Sin aislamiento**, con todos los poderes de la aplicación | Todo | [PLUGINS.md](PLUGINS.md#plugins-de-desarrollo-sin-aislamiento) |

Si dudas, haz uno **con permisos**: quien lo instala ve de antemano qué pide y no tiene que fiarse del código. Uno **con todo el poder** o un **tema** se comparte igual
(archivo, enlace o catálogo), pero quien lo activa **sí** tiene que fiarse de ti: se le enseña el código (o la hoja de estilo) y la aprobación se rompe con cualquier cambio.

## 2. Tu primer plugin en cinco minutos

1. En la aplicación: **Ajustes ▸ Plugins**, escribe un nombre y pulsa **Crear un plugin nuevo**. Se crea una carpeta con tres
   archivos que ya funcionan y se abre para que la veas. (Sin la aplicación a mano: crea tú una carpeta dentro de la carpeta de
   plugins con un `manifest.json`, un `index.html` y un `app.js`, como los de abajo.)
2. En la lista de Plugins, **actívalo**. Una ventana del sistema te enseña qué pide el plugin; pulsa **Activar**. Aparece un
   panel sobre el reproductor, arriba a la izquierda.
3. Edita `app.js` o `index.html`, guarda, y pulsa **Buscar de nuevo** (en Ajustes ▸ Plugins) o **⟳** en la cabecera del panel.
   Se vuelve a cargar sin reiniciar nada.
4. Lo que escribas con `console.log` y los errores salen en **Ajustes ▸ Registro**, con el nombre `plugin:tu-id`.
5. Cuando esté, **Empaquetar para compartir…** crea un archivo `.tdtplugin` (ver [§8](#8-publicar-y-compartir)).

Los tres archivos de un plugin mínimo:

`manifest.json`

```json
{
  "name": "Mi plugin",
  "version": "0.1.0",
  "description": "Qué hace, en una frase.",
  "author": "Tu nombre",
  "tdt": {
    "api": 1,
    "entry": "index.html",
    "label": "Mi plugin",
    "panel": { "width": 320, "height": 180 },
    "permissions": ["player.read"]
  }
}
```

`index.html`

```html
<!doctype html>
<meta charset="utf-8">
<p id="texto">…</p>
<script src="/@tdt/sdk.js"></script>
<script src="app.js"></script>
```

`app.js`

```js
(async () => {
  await tdt.ready;
  const pintar = (estado) => {
    const activa = estado.tiles.find((t) => t.slot === estado.focus) || estado.tiles[0];
    document.getElementById('texto').textContent = activa ? 'Estás viendo ' + activa.name : 'Nada en pantalla';
  };
  pintar(await tdt.player.state());
  tdt.on('player', pintar);
})();
```

El plugin es una **página web normal**: HTML, CSS y JavaScript (puedes usar módulos con `<script type="module">` e `import`,
imágenes, fuentes y audio de tu carpeta). **No puedes usar `fetch` ni siquiera para tus propios archivos** (la política de la caja lo
bloquea todo): los datos que lleve el plugin van en un `.js` o un `.json` que cargas con `<script>` o con `import`, y lo de internet, con
`tdt.net.fetch`. La diferencia es que vive en una caja cerrada y todo lo que quiera de fuera
se lo pide a la aplicación con `tdt`.

## 2b. Un plugin que ocupa la pantalla del reproductor

Con `"panel": { "placement": "screen" }` el plugin no flota: se abre **sobre la imagen del reproductor**, a todo su tamaño y
también en pantalla completa, con un botón propio en la barra de controles (con tu `label`) que lo abre y lo cierra. Sirve para un
teletexto, una guía, un marcador o cualquier cosa que deba verse grande. Es el ejemplo [`ejemplos/pantalla/`](ejemplos/pantalla/).

- **Vídeo y audio siguen** debajo. Tu página decide si es opaca (fondo negro, como un teletexto) o **transparente** (`background:
  transparent`) para mezclarse con la imagen. **Para que la transparencia funcione, declara el esquema de color**
  (`<meta name="color-scheme" content="light dark">` o `:root { color-scheme: light dark }`): sin esa declaración el navegador pinta
  el marco con un fondo blanco opaco (también en los paneles flotantes). Está comprobado en la aplicación real.
- **Pon controles en pantalla: TDT local es para PC y se maneja con el ratón.** Cada cosa que se pueda hacer con una tecla (cambiar de
  página o de canal, abrir un índice, cambiar el modo) tiene que tener también un botón o una fila en la que hacer clic. El teclado
  es un extra para quien lo prefiera (o tenga un mando): al abrirlo se te da el foco, así que `keydown` en tu página recibe los números
  y las teclas de color. Las teclas de la aplicación (F, M…) no actúan mientras tengas el foco; el usuario cierra con el botón **Cerrar**.
  El ejemplo `pantalla` hace las dos cosas: filas de canales que son botones (con foco visible para el teclado) y un botón «Mezclar».
- **La cabecera es de la aplicación**, no tuya: lleva siempre el nombre del plugin y el botón de cerrar, y no se puede quitar ni
  tapar. Así un plugin no puede hacerse pasar por la interfaz.
- **Se avisa al activar** ("se abrirá sobre la pantalla del reproductor… puede tapar la imagen") y pasar de panel flotante a pantalla
  cuenta como cambio de lo aprobado: se vuelve a preguntar.
- Solo se abre uno a la vez; `tdt.ui.resize` no se aplica (la pantalla no cambia de tamaño).

## 3. `manifest.json`

| Campo | Obligatorio | Qué es |
|---|---|---|
| `name` | sí | El nombre que ve el usuario (hasta 120 caracteres). |
| `version` | recomendado | Por ejemplo `1.2.0`. Se muestra al activar y al instalar. |
| `description` | recomendado | Una frase (hasta 400 caracteres). |
| `author` | recomendado | Quién lo hace; se muestra en la pregunta de activación. |
| `homepage` | no | Una dirección `https://` donde está el plugin. |
| `tdt.api` | sí | Tiene que ser `1`. |
| `tdt.entry` | no | La página principal (`.html`), por defecto `index.html`. Tiene que estar dentro de la carpeta. |
| `tdt.label` | no | El título corto de la cabecera del panel (hasta 24 caracteres). |
| `tdt.panel` | no | `true` o `{ "width": 420, "height": 320, "placement": "float" }`. Con panel, el plugin se ve en la ventana: flotante sobre el reproductor (de 240 a 800 de ancho, de 160 a 800 de alto) o, con `"placement": "screen"`, **ocupando toda la pantalla del reproductor** (ver §2b). **Sin panel corre en segundo plano**, sin nada que ver. |
| `tdt.permissions` | no | Lista de permisos (hasta 12). Sin lista, no puede nada salvo mostrarse. |

El **nombre de la carpeta es el id** del plugin: minúsculas, números y guiones, empezando por letra o número (`mi-plugin`,
`futbol-2`). Un manifest con algo que no vale (una página que no existe, un permiso que no existe, un servidor que no es público…)
**se muestra en la lista con el motivo y no se puede activar**: léelo ahí.

Un plugin es de una clase o de otra: no mezcles `tdt.api` con `content_scripts` ni con `tdt.dev`, y no uses los campos de
permisos de Chrome (`permissions`, `host_permissions`…) fuera de `tdt`.

## 4. Permisos

Declara solo lo que uses. El usuario ve esta lista con estas mismas palabras antes de activarlo.

| Permiso | Qué deja hacer |
|---|---|
| `player.read` | Ver qué está viendo el usuario: la lista (TV/radio), el modo, cada casilla, el volumen. No da direcciones de vídeo. |
| `player.control` | Cambiar lo que ve: poner canales, cambiar de lista, volumen, silencio y multivisión. |
| `channels.read` | Buscar en la lista de canales y emisoras (nombre, categoría, id; nunca las direcciones de emisión). |
| `epg.read` | Leer la guía: qué dan ahora y después en un canal. |
| `ui.toast` | Mostrar avisos breves sobre la imagen. |
| `storage` | Guardar datos propios en el equipo (hasta 256 KB). Nadie más los ve. |
| `provide:epg` | Poner programas en la guía de los canales que tu plugin aporta (títulos y horas). Riesgo medio. |
| `provide:channels` | **Riesgo alto.** Añadir canales a la lista del usuario (hasta 500): los enlaces que traiga se podrán abrir desde su equipo, como los que añade él. Para plugins que leen una lista de otro sitio (con `network:`) y la convierten en canales. |
| `network:servidor` | Hablar con **ese** servidor, solo por `https`. Por ejemplo `network:api.open-meteo.com`. `network:*.ejemplo.com` vale para sus subdominios (no para `ejemplo.com` a secas: pídelo aparte si lo necesitas). |
| `embed:servidor` | **Riesgo crítico.** Mostrar dentro de una casilla el reproductor de **ese** servidor (`embed:player.twitch.tv`): una página suya, con sus propios scripts, corre en la ventana del usuario. Sin comodines. Solo para fuentes de reproducción (ver abajo). |

Reglas de `network:`:

- El servidor tiene que ser un **nombre público** con punto (`api.ejemplo.com`). No valen direcciones IP, `localhost`, `.local`,
  `.lan`, `.internal`, ni `*.com`.
- Solo `https`, solo el puerto 443, sin usuario ni clave en la dirección.
- Aunque el nombre sea público, **si apunta a una dirección de tu red o de tu equipo no se conecta** (así un servidor malicioso no
  puede usar tu plugin para llegar a tu router o a TDT local).
- Al plugin nunca se le dan cookies ni credenciales: solo puede mandar las cabeceras `Accept`, `Accept-Language` y
  `Content-Type`. Si un servicio necesita una clave, tendrá que ir en la dirección (`?key=…`), con lo que eso supone: no uses claves
  que no quieras compartir con quien instale el plugin.

**Qué pasa al cambiar permisos.** La aprobación del usuario es de *esto*: el plugin, la versión de la API, la lista exacta de
permisos y si tiene panel o no. Si publicas una versión que pide más (o distinto), **se le vuelve a preguntar** y hasta entonces
no corre. Cambiar el código, el tamaño del panel, la versión o la descripción no vuelve a preguntar. Sé austero: cada permiso de
más es una razón para que alguien no lo active.

## 5. La API (`tdt`)

Se carga con `<script src="/@tdt/sdk.js"></script>` y crea `window.tdt`. **Todo es asíncrono** (devuelve una promesa). Si te falta
un permiso, la promesa falla con un `Error` cuyo mensaje empieza por `permiso denegado: …` y dice cuál falta.

```js
const yo = await tdt.ready;   // { id, name, version, permissions: [...] }
```

Espera a `tdt.ready` antes de pedir nada.

### Errores

Cuando algo falla, la promesa se rechaza con un `Error` que lleva `message` (para ti, en lenguaje llano) y **`code`** (para tu
código, para que no tengas que leer el texto):

| `code` | Cuándo |
|---|---|
| `E_PERMISSION` | No tienes el permiso (no lo declaraste, o el usuario te lo quitó: el mensaje lo dice) |
| `E_INVALID` | Un argumento no vale (el mensaje dice cuál y qué se espera) |
| `E_NOT_FOUND` | Lo que pides no existe (un canal, por ejemplo) |
| `E_UNSUPPORTED` | El método no existe en esta versión de la API |
| `E_UNAVAILABLE` | No se puede ahora: sin red, el servidor no contesta, la aplicación no respondió |
| `E_RATE` | Llamas demasiado deprisa (una ráfaga de 200 y luego 100 por segundo): espera un poco |
| `E_QUOTA` | Te pasaste de un límite (el almacenamiento, el tamaño de una respuesta) |

```js
try { await tdt.player.play('La 2'); }
catch (e) { if (e.code === 'E_NOT_FOUND') mostrar('ese canal no existe'); else if (e.code === 'E_PERMISSION') pedirPermiso(); else throw e; }
```

Todo esto está en una sola especificación, `tdtlocal/static/plugin-api.json`, que lee la aplicación, el servidor MCP (herramienta
`tdt_plugin_api` y recurso `tdt://docs/plugin-api`) y las pruebas: si algo de esta guía no coincide con ella, manda la especificación.

### Reproductor

| Llamada | Permiso | Devuelve |
|---|---|---|
| `tdt.player.state()` | `player.read` | La foto del estado (ver abajo). |
| `tdt.on('player', fn)` | `player.read` | Llama a `fn(estado)` cuando algo cambia (como mucho una vez por segundo). `tdt.off('player', fn)` la quita. |
| `tdt.on('channel.changed', fn)` | `player.read` | Se ha puesto otro canal: `fn({id, name, kind})`. Si lo hizo una regla, trae `cause: 'rule'`. |
| `tdt.on('kind.changed', fn)` | `player.read` | Se ha cambiado de lista (televisión, radio, últimos 7 días): `fn({kind})`. |
| `tdt.on('volume.changed', fn)` | `player.read` | Ha cambiado el volumen o el silencio: `fn({v, m})`. |
| `tdt.on('programme.started', fn)` | `epg.read` | Ha empezado un programa en un canal que se está viendo: `fn({channel, id, title, start})`. |
| `tdt.player.play(canal)` | `player.control` | Pone un canal, por **id o por nombre** (`'La 2'`, sin importar mayúsculas ni tildes). Devuelve el nombre del canal. Falla si no existe o no se puede reproducir. |
| `tdt.player.kind('tv' \| 'radio')` | `player.control` | Cambia de lista. |
| `tdt.player.volume(0..1)` | `player.control` | Fija el volumen. |
| `tdt.player.mute(true \| false)` | `player.control` | Silencia o devuelve el sonido (sin argumento: silencia). |
| `tdt.player.multi([canales], segundos?)` | `player.control` | Multivisión con 1 a 4 canales; `segundos` (10, 15, 20, 30, 45 o 60) para rotar el audio. |

La **foto del estado**:

```js
{
  kind: 'tv',                 // 'tv' | 'radio' | 'u7d'
  mode: 'single',             // 'single' | 'multi'
  layout: 'mosaic',           // 'mosaic' | 'focus' (en multivisión)
  focus: 0,                   // casilla con el audio
  vol: { v: 0.8, m: false },  // volumen 0..1 y si está silenciado
  rot: { on: false, secs: 20 },
  tiles: [{ slot: 0, id: 'la1', name: 'La 1', kind: 'tv' }],   // lo que hay en cada casilla
  u7d: null                   // { channel } si se están viendo grabaciones
}
```

### Canales y guía

| Llamada | Permiso | Devuelve |
|---|---|---|
| `tdt.epg.provide({ canal: [[inicio, fin, título, descripción?, categoría?], …] })` | `provide:epg` | `{ count }`. **Sustituye toda** la guía que aporta tu plugin (`{}` la quita). Tiempos en **segundos desde 1970**; hasta 500 canales y 60 programas cada uno, de hasta 24 horas; lo que ya terminó se descarta. Queda bajo **`tu-id:canal`**: un canal que aportes con `tdt.channels.provide` la usa poniendo `epg: 'tu-id:canal'`. **Nunca sustituye la guía de un canal de las listas.** Vive en memoria: vuelve a entregarla cada vez que arranques. Falla con `E_INVALID` diciendo qué programa está mal. |
| `tdt.channels.provide([{ name, sources, logo, web, kind, category, group, epg }])` | `provide:channels` | `{ count }`. **Sustituye todos** los canales que aporta tu plugin por esta lista (vacía, los quita). Hasta 500, de 1 a 6 enlaces `http(s)` cada uno; `kind` `'tv'` o `'radio'`. Salen en la lista con la categoría «Plugin · tu-id» salvo que pongas otra. **No se admiten cabeceras ni ids propios** (el id lo pone TDT local), y los canales se quitan solos si tu plugin se apaga o pierde el permiso. Falla con `E_INVALID` diciendo qué canal está mal (y no cambia nada). |
| `tdt.channels.search('texto', { kind, limit })` | `channels.read` | `{ total, channels: [{ id, name, kind, category, hasGuide }] }`. Busca palabras en el nombre y la categoría, sin importar tildes; solo canales que se pueden reproducir; `kind` `'tv'` o `'radio'`; `limit` hasta 50 (25 por defecto). |
| `tdt.epg.now(canal)` | `epg.read` | `{ channel, now, next }` con `now` y `next` como `{ start, end, title }` (segundos Unix) o `null`. `canal` por id o nombre. |

### Interfaz

| Llamada | Permiso | Qué hace |
|---|---|---|
| `tdt.ui.toast('texto')` | `ui.toast` | Un aviso de hasta 160 caracteres, unos 4 segundos, con el nombre de tu plugin delante. |
| `tdt.ui.resize(ancho, alto)` | — | Cambia el tamaño de tu panel (dentro de 240–800 × 160–800). Falla si no tienes panel. |

### Plugins con todo el poder y temas

Los botones **Crear un tema** y **Crear un plugin con todo el poder** (en *Ajustes ▸ Plugins*, junto a «Crear un plugin nuevo») hacen una carpeta que ya funciona. Y una IA con acceso de desarrollo puede escribirlos
por ti (`tdt_plugin_write`): verás su código en una ventana antes de que nada se escriba, y otra vez al activarlo.

```json
{ "name": "Mi plugin", "version": "0.1.0", "author": "Tu nombre", "tdt": { "api": 1, "full": { "page": "page.js", "css": "tema.css" } } }
```

- **`page.js`** (opcional) corre dentro de la página con `tdt`: `tdt.on`, `tdt.filter`, `tdt.register`, `tdt.log`, `tdt.css`. Qué ganchos hay y qué se puede hacer con ellos está en [HACKEABLE.md](HACKEABLE.md): la reacción
  a la publicidad (`ad.started`, `ad.reaction`, `ad.actions`), las capas sobre cada casilla (`tile.overlay`)… Corre dentro de una función `async` (`await` al principio, `return () => …` para limpiar; nada de `import` estáticos).
- **`tema.css`** (opcional) es una hoja de estilo que se aplica después de la de la aplicación. Sin `page.js`, es un **tema** y no ejecuta código. Las imágenes y fuentes tienen que estar en tu carpeta; no valen `@import` ni direcciones de fuera. Los nombres que puedes tocar (y que no cambian sin avisar) están en [TEMAS.md](TEMAS.md). Solo hay un tema activo a la vez.
- **Sin permisos que declarar**: un plugin con todo el poder no los pide, y por eso se enseña tu código al activarlo. **Una sola letra cambiada** (de cualquier archivo de la carpeta) y se vuelve a preguntar. No uses archivos ocultos ni `node_modules`: la huella no los cuenta y se rechazan.
- Se empaqueta, se instala y se comparte como los demás (`Empaquetar para compartir…`).

### Temas de colores: un plugin aislado que cambia los colores

Un plugin puede traer uno o varios temas (hasta 5) **sin código ni CSS**: un nombre y los colores de las variables de la aplicación.

```json
"tdt": { "api": 1, "themes": [
  { "id": "rojo", "name": "Rojo", "scheme": "dark",
    "vars": { "--accent": "#ff0033", "--chassis": "rgb(20, 8, 10)", "--ink": "hsl(0 0% 92%)" } }
] }
```

- Las variables que se pueden cambiar son solo estas doce: `--chassis`, `--panel`, `--ink`, `--muted`, `--line`, `--screen`, `--accent`,
  `--accent-ink`, `--row-hover`, `--ok`, `--bad` y `--unk`. **Nada de tipografías, tamaños ni direcciones.**
- Los valores tienen que ser **colores simples**: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` o `hsl()`. Lo demás (`url(...)`, `var(...)`, `calc(...)`,
  nombres como `red`) se descarta, y la variable se queda como estaba. Un tema sin ninguna variable válida no sale.
- `scheme` (`light` o `dark`) le dice al navegador qué colores deben tener los controles nativos.
- **El tema no se aplica solo**: sale en **Ajustes ▸ Plugins ▸ Tema de la aplicación** con el nombre del plugin entre paréntesis, y lo elige el usuario. Si
  el plugin se apaga, la página vuelve a sus colores.

### Reglas y atajos que trae tu plugin

Para un atajo de teclado o una automatización sencilla **no hace falta código**: trae reglas en `tdt.rules` (hasta 10, el mismo formato que en
[REGLAS.md](REGLAS.md), con el disparador `key` para los atajos: `Alt+1`, `Ctrl+Shift+F5`…). **Salen apagadas** en el diálogo *Reglas* y las enciende el
usuario después de leer qué hacen; lo que pongas en `enabled` no cuenta. Si el manifest trae una regla mal formada, el plugin se rechaza diciendo cuál.

### Fuentes de reproducción: enseñar el reproductor de otro servicio

Un plugin puede enseñarle a TDT local a reproducir una dirección que no es un vídeo directo (la página de un canal de Twitch, por ejemplo)
**sin escribir código**: declara una fuente y qué reproductor incrustable enseñar.

```json
"tdt": {
  "api": 1,
  "permissions": ["embed:player.twitch.tv"],
  "sources": [
    { "name": "Twitch", "match": "https://www.twitch.tv/{1}", "embed": "https://player.twitch.tv/?channel={1}&parent={parent}" }
  ]
}
```

- `match` es la dirección que el usuario pone como enlace de un canal propio; `{1}` a `{3}` son huecos (letras, números y `_.~-`).
- `embed` es lo que se enseña en la casilla: puede usar los huecos y `{parent}` (el servidor que enseña la página), que **solo va después de `?`**.
- Los huecos **nunca** van en el servidor, todo es `https`, y hace falta el permiso `embed:` del servidor del reproductor. Hasta 5 fuentes.
- **`control` (opcional): que TDT local pueda silenciar ese reproductor.** Sin él, el reproductor tiene sus propios controles, sonido y avisos y en multivisión
  suenan juntos. Con `"control": "youtube"` (solo para `www.youtube-nocookie.com` o `www.youtube.com`) TDT local lo silencia y le devuelve el sonido como al
  YouTube integrado (pone `enablejsapi=1` y `autoplay` por ti); con `"control": "atres"` (solo `www.atresplayer.com`) usa el protocolo del puente de
  Atresplayer. Son adaptadores que **ya conoce el núcleo**: tu plugin no escribe código y no se pueden usar con otros servidores. Probado con YouTube real:
  el sonido se silencia y vuelve desde TDT local. **Probado con Twitch:
  el reproductor carga y, con un clic en su botón de play, el vídeo arranca; no arranca solo** (ni con `autoplay=true&muted=true` en la
  dirección), así que la casilla avisa de que hay que pulsar play. Un canal desconectado o con contenido para adultos enseña el aviso de Twitch.
- Si el usuario quita el permiso `embed:`, la fuente deja de funcionar sin más. Úsalo solo con reproductores que el servicio ofrece para
  incrustar.

### Servicios: un plugin que duerme hasta su momento

Un plugin **sin panel** que corre en segundo plano gasta un proceso entero (unos 100 MB) aunque no haga nada. Si solo tiene que actuar
cuando pasa algo, dilo en el manifest y **no corre hasta entonces**:

```json
"tdt": { "api": 1, "permissions": ["epg.read", "storage", "ui.toast"],
         "activation": ["onEvent:programme.started", "onTime:21:00"] }
```

| Entrada | Despierta… |
|---|---|
| `onEvent:channel.changed` (o cualquier evento de la API) | cuando pasa ese evento, **si el plugin tiene el permiso** que ese evento pide |
| `onTime:21:30` | todos los días a esa hora; recibe el evento `schedule` con `{at: "21:30"}` |
| `onStartup` | desde el principio, como un plugin sin lista |

- Hasta 8 entradas. **No vale con un panel** (un panel se ve siempre): el manifest da el error.
- Al despertar, el evento que lo despertó **te llega en cuanto tu página dice hola** (`tdt.on(...)`), y los que pasen mientras arranca se guardan (hasta 20).
- Si pasa **un minuto sin llamadas tuyas ni eventos de los que pediste en `activation`**, vuelve a dormir y se libera el proceso. Los demás eventos que
  recibas mientras estás despierto (un cambio de volumen, por ejemplo) **no alargan tu vida**; si no, un evento frecuente lo mantendría despierto siempre. **Tu plugin tiene que poder reconstruirse desde
  `tdt.storage`** al despertar: lo que tengas en memoria se pierde.
- En Ajustes ▸ Plugins y en `tdt_plugins` se ve «dormido, a la espera de su momento» y cuántas veces se ha despertado.

### Ajustes que elige el usuario

Si tu plugin tiene opciones («la ciudad del tiempo», «letra grande»), **no dibujes un formulario**: decláralas en el manifest y la
aplicación lo dibuja por ti en **Ajustes ▸ Plugins**, lo valida y lo guarda.

```json
"tdt": {
  "api": 1,
  "settings": {
    "ciudad":  { "type": "choice",  "label": "Ciudad del tiempo", "options": ["Madrid", "Sevilla"], "default": "Madrid" },
    "grande":  { "type": "boolean", "label": "Letra grande", "default": false },
    "segundos": { "type": "number", "label": "Segundos entre páginas", "min": 5, "max": 600, "default": 20 },
    "saludo":  { "type": "string",  "label": "Saludo", "maxLength": 80, "default": "Hola", "help": "Lo que dice el aviso" }
  }
}
```

Hasta 20 ajustes. Tipos: `boolean`, `number` (`min`, `max`), `string` (`maxLength`, hasta 500) y `choice` (`options`: de 2 a 20 textos).
`default` es opcional (si falta: `false`, `min`, la primera opción o texto vacío). Un manifest con un ajuste mal declarado no se puede activar y
dice por qué.

| API | Permiso | Qué hace |
|---|---|---|
| `tdt.config.get('ciudad')` | ninguno | El valor que eligió el usuario, o tu `default` si no lo ha tocado. |
| `tdt.config.all()` | ninguno | Todos: `{ciudad, grande, segundos, saludo}`. |
| `tdt.on('config.changed', fn)` | ninguno | El usuario ha cambiado un ajuste: `fn({ciudad, grande, …})`. |

Solo el usuario cambia los valores (en los Ajustes, o una IA por MCP **con su permiso en una ventana del sistema**): el plugin solo los lee.

### Datos propios

| Llamada | Permiso | Qué hace |
|---|---|---|
| `tdt.storage.get('clave')` | `storage` | El valor guardado, o `null`. |
| `tdt.storage.set('clave', valor)` | `storage` | Guarda cualquier cosa que se pueda pasar a JSON. |
| `tdt.storage.remove('clave')` | `storage` | Borra. |
| `tdt.storage.keys()` | `storage` | Las claves, ordenadas. |

Límites: claves de hasta 64 caracteres (letras, números, `.`, `-`, `_`); 64 KB por valor; 256 KB y 200 claves en total.
Es **solo tuyo** (otro plugin no lo ve) y sigue ahí al cerrar la aplicación. Desinstalar el plugin no lo borra.

### Internet

```js
const r = await tdt.net.fetch('https://api.ejemplo.com/datos?x=1', { method: 'GET', headers: { Accept: 'application/json' } });
r.status; r.ok; r.url; r.contentType; r.text; r.json();
```

Necesita un `network:servidor` que cubra la dirección. Solo `GET` y `POST` (cuerpo de texto de hasta 100 KB); sigue hasta 3
redirecciones, **cada una comprobada contra tus permisos**; la respuesta se corta si pasa de 1 MB; 15 segundos de tiempo máximo;
hasta 4 peticiones a la vez (el SDK pone en cola las demás: puedes pedir seis cosas de golpe). Es la única vía a internet: el `fetch` normal de la página no funciona (ver §7).

## 5b. Cuando tu plugin va mal, la aplicación lo ve

- **Latido.** La aplicación le pregunta a cada plugin «¿sigues ahí?» cada 5 segundos (lo contesta el SDK, no tu código). Si pasan 15
  segundos sin respuesta, o no arranca en 10, el panel muestra **⚠ no responde** con **⟳** (recargar) y la línea queda en el Registro. Un
  plugin que no arranca se recarga solo una vez. Un bucle largo en tu código (de más de 15 segundos) se verá como un cuelgue.
- **Carga el SDK.** Una página que no carga `/@tdt/sdk.js` no puede contestar al latido: se muestra como «en marcha» pero **no se
  vigila** (si cae, nadie lo ve). Ponlo siempre, aunque solo sea una página estática.
- **Límite de ritmo.** Una ráfaga de 200 llamadas y luego 100 por segundo. Si te pasas, las llamadas fallan con `E_RATE`.
- **Una pantalla cerrada no existe.** Si tu plugin ocupa la pantalla, su marco **se destruye al cerrarla** (cada marco cuesta unos
  100 MB) y se crea de nuevo al abrirla: guarda lo que haga falta con `tdt.storage` y recupéralo al arrancar. No dejes nada que
  dependa de un temporizador en un marco que no se ve: se frena a una vez por segundo.
- **Permisos individuales.** El usuario puede quitar un permiso concreto desde Ajustes ▸ Plugins sin desactivar el plugin: tu plugin
  se reinicia y esa llamada falla con `E_PERMISSION` («el usuario lo ha desactivado»). Tu código debe poder seguir sin él.
- **Qué hace tu plugin se puede consultar**: llamadas, errores, reinicios, peticiones de red y datos guardados, en Ajustes ▸ Plugins y,
  para una IA conectada, con `tdt_plugins`.

## 6. Depurar

- **Modo seguro: arrancar sin ningún plugin.** Si un plugin rompe la aplicación (o sospechas de uno), la aplicación puede arrancar **sin que corra ninguno**, ni de los tuyos, ni los de desarrollo, ni los que vienen incluidos.
  - **Cuándo entra:** **sola**, si la aplicación se ha cerrado mal (se ha caído o la han matado) **las dos últimas veces seguidas** que arrancó; **a mano**, con *Ajustes ▸ Plugins ▸ Reiniciar en modo seguro* o el menú de la bandeja, o
    arrancando con `--safe` o con la variable `TDT_SAFE_MODE=1`.
  - **Cómo se nota:** el título de la ventana dice «MODO SEGURO» y hay un aviso abajo con el motivo y un botón **Salir del modo seguro** (reinicia con tus plugins). Un cierre limpio no cuenta como fallo.
  - **No pierdes nada:** lo que tenías activado, los permisos y los ajustes siguen guardados y vuelven al salir. Mientras dura **no se puede activar ni apagar nada** (para no pisar lo guardado), ni por la interfaz ni por MCP;
    sí se pueden leer los plugins, el Registro y el Inspector, y desinstalar o cambiar los archivos de un plugin a mano.
  - **Cómo encontrar al culpable:** entra en modo seguro, mira el Registro (lo último antes del cierre), sal y activa los plugins de uno en uno.
- **Límites de memoria y procesador.** Un plugin con página corre en un proceso propio (unos 100 MB). La aplicación mira los procesos cada 5 s y **para el marco** de un plugin que:
  - **usa más de 300 MB** (en dos miradas seguidas, para no confundir un pico al cargar con una fuga), o
  - **ocupa más del 80 % de un procesador durante 20 s sin respiro**.

  Se ve en el Registro (`[plugin:tu-id] se para: memoria…`), en el estado de Ajustes ▸ Plugins («parado por pasarse de memoria o procesador», con una marca ⚠), en el Inspector y por MCP
  (`tdt_plugins` ▸ `runtime.state: over-limit`, `overLimit: memory | cpu`). **⟳ Recargar** lo vuelve a arrancar. Mientras corre, el estado también enseña su memoria y su procesador. Si tu plugin necesita
  más de 300 MB, probablemente guarda demasiado en memoria: usa `tdt.storage` y rehazlo al arrancar.
  *Límites de la medición:* se mide el **proceso**, y al reiniciar un plugin parado Chromium suele reutilizar el mismo proceso, que tarda en devolver su memoria. Por eso un plugin que se reinicia solo se
  vuelve a parar si **crece** respecto a lo que el proceso ya tenía, y lo que vuelve a reservar en esa memoria retenida no se distingue hasta que el proceso la devuelve.
- **El Inspector** (Ajustes ▸ Plugins ▸ **Inspector**): una línea de tiempo **en directo** con los eventos de la aplicación, lo que piden los plugins (qué método
  llamó cada uno y cómo acabó: `ok`, `E_PERMISSION`, `E_RATE`…, y cuánto tardó) y lo que hacen las reglas. Se puede filtrar por tipo o por texto
  (`E_PERMISSION`, el nombre de tu plugin…) y pausar. **Solo mira y nunca enseña los datos** de las llamadas, solo quién, qué y cómo acabó. Si algo «no pasa»,
  aquí se ve si tu plugin lo llama y por qué falla. Una IA lo ve con `tdt_plugin_calls`.
- **`console.log`, `console.warn` y `console.error`** de tu página salen en **Ajustes ▸ Registro** con el nombre
  `plugin:tu-id`. Las llamadas que hacen `tdt.net.fetch` y `tdt.storage` también dejan su línea (y sus fallos).
- **Mensajes frecuentes**

| Mensaje | Qué pasa |
|---|---|
| `permiso denegado: player.read (falta en tdt.permissions de manifest.json)` | Usas algo que no declaraste. Añádelo al manifest y vuelve a activar (se te volverá a preguntar). |
| `permiso denegado: network:otro.com` | El servidor no está en tus permisos (también ocurre con una redirección a otro servidor). |
| `… no es una dirección pública` | El nombre apunta a tu red o a tu equipo: no se permite. |
| `método desconocido` | Un nombre de la API mal escrito. |
| `este plugin tiene que correr dentro de TDT local` | Abriste `index.html` en un navegador suelto: solo corre dentro de la aplicación. |
| El panel sale en blanco | Mira el Registro: suele ser un error de JavaScript, o una ruta de archivo mal puesta (`/@tdt/sdk.js` con ese nombre exacto). |
| `violates the following Content Security Policy directive` (en el Registro) | Intentaste algo que la página tiene cerrado (ver §7). |

- La caja del plugin no se puede inspeccionar con las herramientas de desarrollo normales de la ventana. Para depurar a fondo,
  arranca la aplicación desde el código fuente con `TDT_DEBUG_PORT=9222` y abre `http://127.0.0.1:9222` en un Chrome: ahí aparece
  cada plugin como un marco más.

### Un banco de pruebas para tu plugin

`scripts/plugin-lab/` tiene la aplicación real con plugins que se portan mal a propósito (se cuelgan, se inundan de llamadas, caen, piden lo
que no deben) y un guion, `node scripts/plugin-lab/bench.mjs`, que comprueba con límites que fallan que la aplicación aguanta. Sirve para
quien toque la aplicación; si tu plugin se porta mal, el Registro y Ajustes ▸ Plugins ya te lo dicen.

## 7. Qué es una «caja cerrada» y qué garantiza

Cada plugin corre en un marco `sandbox` (sin permiso de mismo origen), servido por la aplicación desde una dirección propia
(`tdt-plugin://tu-id/`), con esta política: puede ejecutar **sus** scripts y estilos y mostrar **sus** imágenes, fuentes y audio, y
**nada más**:

- No puede hacer peticiones de red (`fetch`, `XMLHttpRequest`, `WebSocket`, imágenes o scripts de fuera): todo eso lo bloquea la
  política. Para internet, `tdt.net.fetch`.
- No ve la página de TDT local, ni su servidor, ni los archivos del usuario, ni `localStorage` ni cookies, ni las ventanas
  vecinas, ni las de otros plugins.
- No puede abrir ventanas, navegar a otra dirección ni enviar formularios.
- Solo habla con la aplicación por `tdt`, y la aplicación contesta únicamente a lo que declaraste y el usuario aprobó, y lo
  vuelve a comprobar por su cuenta para lo delicado (archivos y red).

Probado en la aplicación real con un plugin hostil que intenta todo lo anterior (y no lo consigue). **No es una garantía
absoluta.** Cosas que esta caja no cierra y que conviene saber:

- **WebRTC** y algunas precargas del navegador (`dns-prefetch`) pueden filtrar datos a un tercero en un caso extremo. Por eso
  el permiso `player.read` solo da lo que se ve, nunca direcciones de emisión, y por eso hay que activar solo plugins de gente en la
  que se confía.
- Un plugin puede gastar CPU o memoria; si un plugin va mal, desactívalo en la lista.
- Un plugin con `player.read` más `network:` puede **contar a ese servidor lo que ves**: es exactamente lo que se le avisa al
  usuario al activarlo, y no hay forma de que una cosa sin la otra lo haga.
- La caja no se ha probado en macOS ni en Linux (la aplicación sí corre en ellos; el aislamiento es el de Chromium).

## 8. Publicar y compartir

1. Pon al día `version` (y `author`, `description`, `homepage`) en el `manifest.json`.
2. En **Ajustes ▸ Plugins**, en tu plugin, **Empaquetar para compartir…** y elige dónde guardarlo. Obtienes un archivo
   `mi-plugin-1.0.0.tdtplugin` (es un zip: la carpeta del plugin, sin archivos ocultos) y su **SHA-256**. El empaquetado es
   reproducible: la misma carpeta da siempre el mismo archivo y el mismo hash.
3. **Publica el archivo y su hash** donde quieras: una release de GitHub, tu web, un mensaje. Es mejor poner el hash en un sitio
   distinto al del archivo (por ejemplo, en el texto de la release) para que quien instala pueda comprobar que no es otro.
4. Quien lo reciba: **Ajustes ▸ Plugins ▸ Instalar desde un archivo…**. Se le enseña el nombre, el autor, la versión, **qué
   permisos pedirá** y el **SHA-256** del archivo para compararlo con el publicado. Si dice que sí, se copia a su carpeta. **Instalar
   no activa**: activarlo es otra pregunta, y es la que decide.
5. **Para actualizar**, publica un archivo nuevo con una `version` mayor. Quien lo instale reemplaza la carpeta; si pides
   permisos nuevos se le vuelve a preguntar antes de que corra, y si no, sigue como estaba.

Un paquete se rechaza si tiene rutas que salen de la carpeta, enlaces simbólicos, archivos cifrados, más de 200 archivos o más de
8 MB, o si dentro no hay una sola carpeta con nombre de plugin válido y un `manifest.json` correcto.

### Instalar desde un enlace o desde un catálogo

**Ajustes ▸ Plugins ▸ Instalar desde internet.** Nada se descarga hasta que lo pides.

- **Desde un enlace:** pega la dirección `https://…/mi-plugin.tdtplugin` y, si quieres, el **SHA-256 que publica su autor**. Con él, un archivo distinto se
  rechaza antes de enseñarte nada. Sin él, la pregunta dice que *nadie ha comprobado el archivo* y te enseña su SHA-256 para que lo compares.
- **Desde un catálogo:** pega la dirección de un `index.json` (queda guardada en tu navegador) y pulsa *Ver el catálogo*: sale la lista con **Instalar**,
  **Actualizar** (si ya tienes otra versión) o **Instalado**. Cada entrada **fija su archivo con el SHA-256**, así que lo que se descarga tiene que ser exactamente eso.
- **Siempre la misma pregunta que con un archivo:** nombre, autor, versión, **de qué servidor viene**, **qué permisos pedirá** (leídos del paquete, no de lo que
  diga el catálogo) y el SHA-256. **Instalar no activa**; activarlo es otra pregunta.
- **Qué se descarga y de dónde:** solo `https`, puerto 443, sin usuario en la dirección, **un nombre público** (ni IP, ni `localhost`, ni `.local`/`.lan`), solo a
  direcciones públicas (se comprueba al conectar), hasta 3 redirecciones comprobadas una a una, 16 MB para un plugin y 1 MB para un catálogo.
- **Una IA no instala nada**: instalar código es decisión tuya, en esa ventana.

### Firmar tu plugin (firma de autor)

Para que quien instale pueda saber que el archivo es **tuyo** y que nadie lo ha cambiado, fírmalo con una clave ed25519. La herramienta es `scripts/plugin-sign.mjs` y no usa red:

```bash
node scripts/plugin-sign.mjs keygen mi-clave.json                    # una vez: crea tu clave y te da su HUELLA
node scripts/plugin-sign.mjs sign mi-plugin-1.0.0.tdtplugin mi-clave.json   # escribe mi-plugin-1.0.0.tdtplugin.sig
node scripts/plugin-sign.mjs verify mi-plugin-1.0.0.tdtplugin               # comprueba la firma
```

- **`mi-clave.json` lleva tu clave privada: guárdala y no la publiques.** Quien la tenga puede firmar como tú. La **huella** (32 cifras en grupos de cuatro) sí se publica, en un sitio
  distinto al del archivo, para que se pueda comparar.
- Publica el **`.sig` junto al `.tdtplugin`** (la misma dirección más `.sig`: TDT local lo busca solo; en un archivo, el `.sig` de al lado), o pon su contenido en `signature` de tu entrada del catálogo.
- **Cómo lo ve quien instala:** no hay una autoridad que avale tu clave. La primera vez se le enseña la huella («primera vez que ves esta clave para este plugin») y decide; desde entonces la app **recuerda con qué clave se instaló cada plugin**:
  la misma clave se reconoce; **otra clave** (⚠ *la clave ha cambiado*) o **ninguna firma en un plugin que venía firmado** (⚠ *sin firma*) salen como un aviso en la pregunta, y una firma que **no corresponde al archivo se rechaza** sin preguntar.
- Si pierdes la clave o te la roban, publica una nueva con su huella: quien tenga tu plugin verá el aviso de «la clave ha cambiado» y tendrá que decidir.

**Publicar un catálogo** es subir un `index.json` a donde quieras (una página de GitHub, tu web):

```json
{ "plugins": [
  { "id": "tiempo", "name": "El tiempo", "author": "Ana", "version": "1.2.0", "description": "Cuenta el tiempo de tu ciudad",
    "url": "https://ejemplo.org/plugins/tiempo-1.2.0.tdtplugin", "sha256": "e3b0c442…(64 cifras)", "permissions": ["network:api.open-meteo.com"] }
] }
```

`id`, `name`, `url` y **`sha256` son obligatorios** (una entrada sin hash se descarta y se avisa); `permissions` es solo una pista, hasta 200 plugins. El `sha256` sale de
*Empaquetar para compartir…*. `signature` (opcional) es el contenido del `.sig` de tu plugin: el catálogo enseña la huella de cada entrada. Todavía **no hay actualizaciones con
diferencias a la vista**.

## 9. Con ayuda de una IA

Puedes pedirle a una IA que te escriba el plugin: dale esta guía y el ejemplo de [`ejemplos/ahora/`](ejemplos/ahora/), dile qué
quieres, y pega lo que te dé en los archivos de la carpeta que crea **Crear un plugin nuevo**. Si has conectado una IA por el
[servidor MCP](PLUGINS.md#el-servidor-mcp-lo-que-hay-hoy), puede leer esta guía ella misma (recurso `tdt://docs/plugins`), consultar
la API exacta (`tdt_plugin_api`), ver qué plugins hay y cómo van (`tdt_plugins`, `tdt_plugin_logs`: estado, actividad, errores) y,
si le das el nivel «plugins», apagarlos o quitarles permisos; **activar uno o devolverle un permiso siempre te lo pregunta a ti** en
una ventana del sistema.
Revisa siempre el `manifest.json` antes de activar: **los permisos que pide son lo único que importa**. Si una IA te escribe un
plugin de saludo que pide `network:` de un servidor raro, algo no cuadra.

### Que la IA programe el plugin ella misma, por MCP

Con el nivel «plugins» del [servidor MCP](PLUGINS.md#el-servidor-mcp-lo-que-hay-hoy), una IA (Claude, un modelo local…) puede
**escribir, probar y corregir un plugin con permisos sin que tú toques un archivo**:

1. `tdt_plugin_write` con `dry_run: true` comprueba el plugin: el manifest como lo lee la aplicación, la sintaxis de cada script (con su
   línea) y avisos de lo que suele salir mal (sin SDK, `fetch()` bloqueado, permisos de más o de menos). No molesta al usuario.
2. `tdt_plugin_write` sin `dry_run` **te enseña en una ventana del sistema** qué podrá hacer el plugin (con el riesgo de cada permiso) y el
   código, y solo si aceptas se escribe. **Escribir no activa nada.**
3. `tdt_plugin_enable` te pregunta si lo activas (otra ventana, con los permisos a la vista).
4. La IA ve cómo va con `tdt_plugins` (en marcha, no responde, errores) y `tdt_plugin_logs` (lo que ha escrito el plugin), y lo corrige con
   `tdt_plugin_read` y otro `tdt_plugin_write`. Si los permisos no cambian y está activado, **se recarga solo** al aceptar; si pide
   permisos nuevos, tienes que volver a activarlo.

Cada cambio te lo pregunta a ti: la ventana nativa es la única puerta, y ninguna página puede pulsarla. Si una IA te escribe algo que pide
`network:` de un servidor raro, lo ves antes de que corra.

## 10. Ideas que caben (y alguna que no)

- Un reloj, un temporizador o un marcador de «mañana juega…» que mire la guía y avise con `ui.toast`.
- Un selector de canales propio (una rejilla con tus favoritos) que use `player.play`.
- Un panel de datos: tiempo, bolsa, tráfico, el resultado de un partido de una API pública (`network:`).
- Una ficha de lo que están echando, que busque el título en una base de datos abierta.
- Un mando por voz o por texto que traduzca lo que escribes a `player.play` y `player.volume`.

Lo que **no** se puede (todavía): leer o grabar el vídeo, tocar el reproductor de un canal ajeno, abrir ventanas propias, guardar
archivos en el disco, correr un proceso propio o un servidor, ni escribir subtítulos sobre la imagen. Si algo de eso te hace falta,
dilo en una incidencia: cada nueva capacidad entra como un permiso nuevo, con su pregunta.

## 11. Preguntas frecuentes

**¿Puedo usar una librería (React, Vue…)?** Sí, copiándola a tu carpeta y cargándola con `<script src="lib.js">`: la política
no deja cargar nada de fuera. Cuida el tamaño: el paquete tiene un máximo de 8 MB.

**¿Puede mi plugin hablar con otro?** No. Cada plugin ve solo a la aplicación.

**¿Funciona sin conexión?** El plugin sí; lo que dependa de `tdt.net.fetch`, no. Guarda lo último con `storage` para tener algo
que enseñar (como hace el ejemplo del tiempo).

**¿Qué pasa si publico una versión con un fallo de seguridad?** Sube una nueva con el arreglo y avisa; quien tenga la vieja tendrá
que instalar la nueva. No hay forma de actualizarlo a distancia: es a propósito.

**¿Por qué mi plugin sale como «no se puede usar»?** Por lo que dice debajo del nombre. El manifest se comprueba entero al
buscar los plugins y muestra todos los problemas a la vez.
