# Plugins abiertos y acceso para IAs (borrador de diseño)

> **Cómo debe ser la ejecución y la estructura de los plugins «de todo tipo», con mediciones: [PLUGINS-ARQUITECTURA.md](PLUGINS-ARQUITECTURA.md).**
>
> **Para hacer un plugin y compartirlo, la guía es [HACER-PLUGINS.md](HACER-PLUGINS.md)**: este documento es el diseño y las
> decisiones de fondo.
>
> **Estado (versión 1.5.0): lo que se construyó está descrito en [HACKEABLE.md](HACKEABLE.md) (la visión y el estado de los ganchos, los plugins con todo el poder, las capas y los temas) y en las secciones «lo que hay hoy» de abajo. El resto de este documento es el diseño original y marca lo que falta.**
>
> **Estado del diseño original: borrador, salvo las fases 0, A, B, C y la parte de E para plugins de desarrollo.** Los **plugins con permisos**
> (fase A: marco aislado, permisos declarados y concedidos, SDK, panel, almacenamiento, red, empaquetar e instalar `.tdtplugin`) y
> los **plugins de desarrollo**
> (fase 0), el **bus de control** (fase B), el **servidor MCP** (fase C: lectura, control y escribir plugins de
> desarrollo) están en el código, sin publicar todavía: ver
> [Escribir un plugin de desarrollo](#escribir-un-plugin-de-desarrollo-lo-que-hay-hoy),
> [El bus de control](#el-bus-de-control-lo-que-hay-hoy) y [El servidor MCP](#el-servidor-mcp-lo-que-hay-hoy). Todo lo
> demás (permisos, plugins de interfaz, de datos y de servicio, y la administración de ajustes y plugins normales por el
> MCP) es una propuesta para discutir antes de construir. Lo que existe hoy está en [DESKTOP.md](DESKTOP.md). Lo que no se ha comprobado va marcado como
> **(por comprobar)**.

## Qué se quiere

1. Que **cualquiera pueda hacer un plugin de lo que sea**, con poco código y sin pedir permiso a nadie para empezar.
2. Que **cualquier IA** (Claude, un modelo local, lo que venga) pueda **conectarse** a TDT local, mirarlo, controlarlo y,
   sobre todo, **escribir plugins y probarlos en un ciclo corto**. Esto es, entre otras cosas, una oda al *vibecoding*: la
   extensión debería ser algo que una IA hace bien en una tarde.
3. Sin que eso convierta el programa en una puerta abierta. «Plugins de lo que sea» y «una IA puede tocar por dentro» son
   las dos funciones más peligrosas que se pueden añadir a una aplicación de escritorio: el diseño parte de ahí.

**Lo que no se quiere:** una tienda, plugins que se actualizan solos desde internet, ni código que se ejecute sin que el
usuario lo haya activado y sepa lo que pide.

## Dónde estamos hoy (1.5.0)

Hay **cuatro clases de plugin** (todas en la aplicación de escritorio, ninguna en el modo navegador; todas empiezan desactivadas y se gestionan en Ajustes ▸ Plugins):

| Clase | Manifest | Cómo corre | Qué puede |
|---|---|---|---|
| **De página** (la primera que hubo) | `content_scripts`, como una extensión de Chrome | scripts en las páginas ajenas que declara (hoy, Atresplayer) | lo que esa página le deja; se rechaza el que pida `permissions`, `host_permissions` o patrones demasiado anchos |
| **Con permisos** | `"tdt": {"api": 1, …}` | marco aislado (`sandbox`), sin red ni acceso a la aplicación salvo el SDK | solo lo que declara y tú concedes: ver qué ves, poner canales, la guía, avisos, guardar datos, hablar con un servidor, ajustes generados, servicios que duermen, fuentes de reproducción declarativas, proveedores de canales y guía, reglas y temas de 12 colores |
| **Con todo el poder** | `"tdt": {"api": 1, "full": {"page": …, "css": …}}` | dentro de la página, **sin aislar**, con los ganchos de la aplicación | cualquier cosa que haga la aplicación; la aprobación va atada a la huella de su código ([HACKEABLE.md](HACKEABLE.md), [TEMAS.md](TEMAS.md)) |
| **De desarrollo** | `"tdt": {"api": 0, "dev": {…}}` | sin aislar, en la página y en el proceso principal (Node), con el modo desarrollador | todo; para quien desarrolla o una IA que edite archivos, con recarga en caliente |

Además: el **bus de control** y el **servidor MCP** (una IA lee, controla y, con el tercer nivel, escribe plugins de desarrollo), las **reglas** sin código, el **modo seguro**, el **inspector** y los **límites** de memoria y procesador. Lo que **no** hay todavía: plugins que corran en el servidor de Python (el cargador existe y no se usa), el alcance `main` en los plugins que se instalan, plantillas de interfaz, un reproductor propio por plugin, y probarlo todo en macOS y Linux.

## Tipos de plugin

| Tipo | Qué hace | Ejemplo |
|---|---|---|
| **De página** (ya existe) | Scripts en webs ajenas | Leer la lista «Emitido en TV» de Atresplayer |
| **De interfaz** | JavaScript dentro de TDT local con una API pequeña y estable | Un panel con la guía de la semana; un botón «copiar enlace» |
| **De datos** | Aportan canales, guía o grabaciones | U7D de otra cadena; una lista de canales propia |
| **De servicio** | Reaccionan a eventos y hablan con algo de fuera | Avisar a Home Assistant cuando empieza publicidad |
| **De desarrollo** | **Sin aislamiento ni permisos**: corren con los mismos poderes que la aplicación | Sustituir los anuncios reescribiendo la lista HLS; atajos globales; probar un cambio de la interfaz sin reconstruir |

Los tres primeros corren aislados y con permisos. El de desarrollo es **otra cosa** y se explica [más abajo](#plugins-de-desarrollo-sin-aislamiento).
Un mismo plugin normal puede mezclar varios de los tres primeros. La compatibilidad con los actuales se mantiene: lo que hoy es un manifest de Chrome
sigue valiendo y los permisos nuevos viven en una clave propia (`tdt`).

## El cambio de fondo: de «sin permisos» a «permisos declarados»

Hoy se rechaza todo lo que pida algo. Para que «de lo que sea» no sea «cualquiera te cuela código», se da la vuelta:

1. El plugin **declara** lo que necesita en el manifest.
2. Al activarlo, la aplicación **lo enseña** con palabras claras («Este plugin quiere: ver qué canal está sonando; hablar con
   `api.telegram.org`»).
3. El usuario **concede** o no. Se guarda por plugin, y cambiar el manifest (otra versión que pide más) **vuelve a
   preguntar**.
4. Todo empieza **apagado**. Sin permiso declarado, la llamada falla.

### Ejemplo de manifest

```json
{
  "name": "Aviso de publicidad por Telegram",
  "version": "0.1.0",
  "description": "Manda un mensaje cuando empieza una pausa de anuncios en el canal que estás viendo.",
  "tdt": {
    "api": 1,
    "service": "service.js",
    "permissions": ["events.markers", "player.read", "network:api.telegram.org", "storage"]
  }
}
```

`tdt.api` es la versión de la API que el plugin espera: así se puede evolucionar sin romper a nadie.

### Permisos (primera propuesta)

| Permiso | Da acceso a |
|---|---|
| `channels.read`, `epg.read` | La lista de canales y la guía |
| `player.read` | Qué suena y cómo (canal, volumen, multivisión) |
| `player.control` | Cambiar de canal, volumen, multivisión |
| `events.markers` | Marcas de anuncios y su inicio y fin |
| `ui.panel`, `ui.toast` | Un panel propio y avisos en pantalla |
| `storage` | Un almacenamiento propio, aislado del de los demás |
| `network:<host>` | Peticiones a ese host y a ninguno más (uno por línea) |
| `log.write` | Escribir en el Registro, con el nombre del plugin |

**No concedibles a un plugin** (solo el usuario, desde la aplicación): cambiar ajustes, activar o instalar plugins, salir,
leer el Registro entero, capturas de pantalla.

## Cómo corre un plugin

**Idea:** cada plugin de interfaz o de servicio corre en su **propio marco aislado** (`<iframe sandbox="allow-scripts">`, sin
el origen de la aplicación, sin sus cookies ni su almacenamiento) y solo habla con la aplicación por una **API de mensajes**
(`tdt.player`, `tdt.events`, `tdt.ui`, `tdt.storage`, `tdt.net`) donde **cada llamada se comprueba contra lo concedido**.

- **Red:** el plugin no hace peticiones propias; las pide a `tdt.net.fetch`, que solo atiende los hosts concedidos, solo por
  `https`, y nunca a direcciones de la red local ni de metadatos (las mismas reglas que ya aplica el proxy).
- **Sus archivos** se sirven desde un protocolo propio de la aplicación (por ejemplo `tdt-plugin://<id>/`) con una política de
  seguridad (CSP) por plugin. **(por comprobar:** que esto funcione con el CSP estricto que ya tiene la página, que prohíbe
  scripts en línea, y qué parte se puede hacer con el protocolo de Electrón y qué no.)
- **Plugins de datos** (por ejemplo U7D): registran un proveedor con funciones `channels()`, `programmes(canal)` y
  `play(programa)`; devuelven direcciones HLS, que la aplicación reproduce con su proxy actual, que ya valida los hosts.
  Atresplayer saldría del núcleo y sería el primero de estos.
- **Solo JavaScript y solo en la aplicación de escritorio** en la primera versión. El modo navegador queda sin plugins
  (hoy tampoco los tiene).

### Lo que esto no resuelve

Un marco aislado y una API con permisos contienen mucho, **no todo**: un plugin con `network:` y `player.read` puede
mandar fuera lo que estás viendo. Por eso los permisos se enseñan en claro y se vuelven a pedir al cambiar. Y el código de
un plugin lo puede leer cualquiera que quiera, pero no lo va a leer casi nadie. **El modelo de amenazas es «código que el
usuario eligió ejecutar, con alcance limitado», no «código en el que se pueda confiar a ciegas».**

## Plugins de desarrollo (sin aislamiento)

Para quien quiere **hacer cualquier cosa**: el plugin corre **sin marco aislado y sin permisos**, con los mismos poderes que
la aplicación. Es el banco de pruebas de quien desarrolla (o de una IA que desarrolla contigo), no el formato para repartir.
**Hay que decirlo sin adornos: un plugin de desarrollo equivale a ejecutar código arbitrario con tu usuario.** El diseño no
intenta evitar eso (es el punto), sino que **no ocurra por accidente ni por engaño**.

### Hasta dónde llega: tres alcances

Un plugin de desarrollo declara en qué sitios corre; puede usar uno, dos o los tres.

| Alcance | Corre en | Puede | Ejemplo |
|---|---|---|---|
| `page` | La página de TDT local (mundo principal) | Leer y cambiar el DOM y el estado, parchear los módulos de la interfaz | Probar un botón nuevo sin reconstruir nada |
| `main` | El proceso principal de Electrón (Node) | Sistema de archivos, procesos, red sin límites, ventanas, bandeja, atajos globales | Integrar con OBS; abrir una ventana propia |
| `server` | El servidor Python | Rutas nuevas (`/api/...`), ganchos en el proxy, leer la caché | «Sustituir los anuncios» de la hoja de ruta: reescribir la lista entre `cue-out` y `cue-in` |

**(por comprobar:** que el servidor congelado con PyInstaller pueda cargar un `.py` suelto de una carpeta y qué módulos de
terceros tendría disponibles, porque solo lleva lo que se empaquetó.)

### Manifest

```json
{
  "name": "Sustituir anuncios",
  "version": "0.0.1",
  "description": "Cambia la pausa de anuncios por otro stream.",
  "tdt": {
    "api": 0,
    "dev": { "server": "server.py", "page": "page.js" }
  }
}
```

No lleva `permissions`: no hace falta, lo tiene todo. `api: 0` significa **sin garantías**: la API de desarrollo puede
cambiar en cualquier versión. Recibe, además del entorno en bruto, el mismo objeto `tdt` que los plugins normales (sin
comprobar permisos), un registro con su nombre y **recarga en caliente** al cambiar un archivo.

### Guardarraíles (para que no sea un vector de malware)

1. **Modo desarrollador, apagado por defecto.** Un interruptor explícito (Ajustes ▸ Desarrollo), con un texto que dice lo que
   implica y una confirmación. También se puede activar con `TDT_DEV=1` para quien arranca desde una terminal. **No se
   puede activar desde un plugin, ni por el MCP, ni por la API del servidor.**
2. **Una carpeta propia** (`<datos>/dev-plugins/`, o `TDT_DEV_PLUGINS_DIR`). Los de desarrollo **solo se cargan de ahí**:
   nunca desde el instalador por enlace o por zip, ni desde la carpeta de plugins normales, ni desde ningún sitio al que
   pueda escribir una web o un plugin. Un manifest de desarrollo en la carpeta normal se rechaza.
3. **Se activan a mano.** Cada plugin de desarrollo, la primera vez; y otra vez si cambia lo que declara (los alcances).
   Su código sí puede cambiar libremente, porque la recarga en caliente es lo que se busca.
4. **Siempre visible.** Un aviso permanente en la ventana y en la bandeja («Modo desarrollador: N plugins sin aislar») y una
   línea en el Registro en cada arranque. Nadie debería olvidar que lo tiene encendido.
5. **No se reparten tal cual.** Para publicar un plugin hecho en desarrollo se **gradúa** a un plugin normal (aislado, con sus
   permisos declarados); la documentación lo dice y el instalador por enlace no acepta otra cosa. Dev es el banco de
   pruebas; los permisos son el destino.
6. **Con IAs: dos caminos, y uno es muy distinto del otro.**
   - **Una IA que edita los archivos de `dev-plugins/` directamente** (Claude Code, tu editor con IA): la aplicación
     recarga y ya está. Esto no añade nada nuevo: una IA con escritura en tus carpetas ya puede hacer cualquier cosa en tu
     equipo.
   - **Una IA conectada por el MCP** (que puede estar leyendo texto de internet con instrucciones escondidas): escribir o
     activar un plugin de desarrollo es **ejecución remota de código por un modelo**. Va en un **cuarto nivel, «Desarrollo»**,
     apagado, separado de «Administración», y cada escritura **pide confirmación en la app mostrando el código**.

### Lo que esto no resuelve

El modo desarrollador no protege de un plugin de desarrollo malo que **tú mismo** pongas ahí y actives: eso es ejecutar
código. Tampoco hay manera de impedir que alguien le diga a otra persona «activa el modo desarrollador y copia esto»: el
texto de la confirmación tiene que ser claro y poco amable, y el aviso permanente, imposible de ignorar. **Es una
decisión de diseño aceptar ese riesgo para dar a quien desarrolla las manos libres.**

### Escribir un plugin de desarrollo (lo que hay hoy)

Hecho en la fase 0; el alcance `server` (Python) todavía no existe. **Un ejemplo para copiar:**
[`docs/ejemplos/plugin-desarrollo-hola/`](ejemplos/plugin-desarrollo-hola/).

1. **Enciende el modo desarrollador** en Ajustes ▸ Desarrollo (una pregunta de la propia aplicación que la página no puede
   responder), o arranca con `TDT_DEV=1`.
2. **Copia el plugin** a la carpeta que ahí se indica: `<datos>/dev-plugins/<nombre>/` (o la de `TDT_DEV_PLUGINS_DIR`). El
   nombre de la carpeta solo puede llevar letras, números, punto, guion y guion bajo.
3. **Actívalo** en esa pestaña. Otra pregunta, que dice qué va a poder hacer. A partir de ahí, **cada vez que cambies un
   archivo se recarga solo** (la página, si el plugin tiene `page`; el proceso principal, si tiene `main`).

El manifest lleva `"tdt": { "api": 0, "dev": { "page": "page.js", "main": "main.js" } }`; los dos alcances son opcionales
pero tiene que haber al menos uno.

- **`page.js`** corre en el mundo de la página, dentro de una función `async`: puede llevar `await` al principio, pero no `import`
  estáticos. Recibe `tdt`: `tdt.id`, `tdt.log(...)` y `tdt.error(...)` (escriben en el Registro con el nombre del plugin) y los **ganchos** de la
  aplicación (`tdt.on`, `tdt.filter`, `tdt.register`, `tdt.do`; ver [HACKEABLE.md](HACKEABLE.md)); si el archivo termina con `return () => {...}`, se llama
  al apagarlo. Con `await import('/js/state.js')` se obtiene **la misma instancia** de los módulos de la interfaz, así que tiene acceso a
  todo su estado. Lo carga el mismo cargador que los plugins incluidos (`dev:<id>`): un fallo se cuenta y se salta, y con cinco se apaga solo ese plugin.
- **`main.js`** es un módulo ES que exporta una función (`export default` o `export function activate`) y, si quiere,
  `deactivate`. La función recibe `{ id, log, warn, error, electron, app, getWindow, serverUrl, showWindow, reload, dataDir }`.
  Corre con Node y Electrón completos. **Usa `dataDir` para guardar lo suyo:** la carpeta del plugin se vigila y escribir
  en ella lo recarga en bucle. Los módulos que `main.js` importe (otros archivos) se guardan en caché y **no** se recargan
  solos: lo que sí se recarga es `main.js`.
- **Un error de sintaxis** en `page.js` se ve en la lista, con su línea, y el plugin no corre. Un error al arrancar `main.js`
  sale en la lista y en el Registro.
- **Si cambia lo que declara** (por ejemplo, añades `main`), deja de correr hasta que lo actives otra vez.

Lo que se ha comprobado con la aplicación real, en Windows: los dos alcances corren, la recarga en caliente, el aviso
permanente y la pestaña, que un plugin de desarrollo en la carpeta de plugins normales se rechaza y que con el modo apagado
no se carga nada. **No se ha comprobado a mano** el diálogo nativo de confirmación (las pruebas lo sustituyen), ni nada de
macOS y Linux.

## Plugins con todo el poder (los que se instalan)

Entre el plugin aislado (permisos declarados) y el de desarrollo (sin aislar, con el modo desarrollador), hay un tercero que **cualquiera instala como los demás** y que corre **sin aislar**: el modelo
de WordPress ([HACKEABLE.md](HACKEABLE.md)). Su código corre dentro de la página de TDT local con los ganchos de la aplicación (`tdt.on`, `tdt.filter`, `tdt.register`, `tdt.do`), sin permisos que lo limiten:
puede cambiar lo que hace la aplicación, poner lo que quiera sobre la pantalla y pedir lo que quiera a internet con el acceso de la propia página.

```json
{ "name": "Cartel", "version": "1.0.0", "author": "Ana", "tdt": { "api": 1, "full": { "page": "page.js" } } }
```

- **`page.js`** es como el de un plugin de desarrollo (función `async`, `await` al principio, `return () => …` para limpiar; ver arriba), con los mismos ganchos. Solo existe el alcance **`page`**: `main`
  (Node, archivos y procesos de la máquina) y `server` siguen siendo solo de desarrollo, hasta que tengan su propia pregunta.
- **Se instala como cualquier plugin** (archivo `.tdtplugin`, enlace o catálogo, con SHA-256 y firma de autor); el aviso de instalación dice que **es un plugin con todo el poder** y enseña el principio de su
  código. **Instalar no activa.**
- **La aprobación es del código, no de lo que declara:** al activarlo se enseña su código y una huella (SHA-256 de todos los archivos de su carpeta); si **cambia una sola letra** de cualquier archivo, deja de
  correr y se vuelve a preguntar. El código se vuelve a leer **en el momento de entregárselo a la página** y tiene que dar la huella aprobada (uno cambiado en disco después no corre).
- **No hace falta el modo desarrollador** y no hay aviso permanente: es un plugin normal, como en WordPress. Aparece en *Ajustes ▸ Plugins* con una línea que dice «Sin aislar», con su huella, y en el
  inspector. El **modo seguro** no carga ninguno. Solo llega a la página de TDT local, nunca a otro sitio.
- **Alcance `css`: un tema.** `"full": {"css": "tema.css"}` (solo, o junto a `page`) pone una hoja de estilo después de la de la aplicación; sin `page` no ejecuta código y la pregunta lo dice. Imágenes y
  fuentes de la carpeta se incrustan en la hoja; solo hay un tema a la vez. Ver [TEMAS.md](TEMAS.md).
- **Una IA puede escribirlos** con `tdt_plugin_write` (nivel de desarrollo del MCP): el usuario ve una ventana con otras palabras («un plugin con TODO el poder» o «un tema») y el código o la hoja de estilo, y decide; escribir no activa, y como la aprobación es del código, lo que se escriba después detiene un plugin activado hasta que el usuario lo vuelva a activar. Lo que **no** puede es instalarlos ni activarlos por su cuenta. Los botones **Crear un tema** y **Crear un plugin con todo el poder** hacen una carpeta que ya funciona.
- Si falla, se cuenta y se salta; con cinco fallos se apaga solo ese plugin.

## Acceso para IAs (un MCP)

### Primero: el bus de control

Sin esto no hay nada que ofrecer. Una pieza nueva en el servidor, común a plugins e IAs, que funciona también en modo
navegador:

- **Estado:** la página publica una foto de su estado (qué suena, multivisión, volumen, lista activa) cuando cambia.
- **Órdenes:** la página recoge órdenes de una cola (por eventos del servidor). Las órdenes que ya entiende el asistente
  («pon La 2», multivisión) son el punto de partida, y se ejecutan por el mismo camino que cuando las escribe el usuario.
- **Autenticación:** quien no es la propia página (una IA, un plugin) necesita un **token**; el origen y el `Host` siguen
  comprobándose como ahora.

### El bus de control, lo que hay hoy

Hecho en la fase B. Es lo que un cliente (una IA, el futuro servidor MCP, un plugin) usa para **ver** y **dirigir** la ventana.

1. **Enciéndelo** en Ajustes ▸ Acceso de IAs (o `TDT_CONTROL_ENABLED=1`, y `TDT_CONTROL_LEVEL=control` para el segundo nivel).
   Apagado por defecto. Hay dos niveles: **leer** (qué estás viendo) y **leer y controlar** (poner canales, volumen).
2. **El token** se crea al activarlo y se guarda en `<datos>/control-token`; la pestaña lo muestra (oculto, con «Copiar» y
   «Generar uno nuevo…») y al arrancar el servidor dice en el registro dónde está.
3. **Un cliente** habla con el servidor, solo desde este equipo (también con `--lan`) y con `Authorization: Bearer <token>`:

```bash
TOKEN=$(cat "<datos>/control-token")

curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8790/api/control/v1/state
# {"kind":"tv","mode":"single","layout":"mosaic","focus":0,"vol":{"v":1,"m":false},"rot":{"on":false,"secs":20},
#  "tiles":[{"slot":0,"id":"la-2","name":"La 2","kind":"tv"}],"u7d":null,"age_seconds":1.1}

curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"do":"play","channel":"La 2"}' http://127.0.0.1:8790/api/control/v1/command
# {"ok":true,"detail":"La 2"}
```

| Orden | Cuerpo | Hace |
|---|---|---|
| `play` | `{"do":"play","channel":"<nombre o id>"}` | Pone el canal (cambia de televisión a radio si hace falta) |
| `kind` | `{"do":"kind","kind":"tv"\|"radio"\|"u7d"}` | Cambia de lista |
| `volume` | `{"do":"volume","value":0.3}` | Volumen de 0 a 1 (y quita el silencio) |
| `mute` | `{"do":"mute","on":true}` | Silencia o no |
| `multi` | `{"do":"multi","channels":["La 1","La 2"],"rotate":30}` | Multivisión con hasta 4 canales; `rotate` son los segundos |

Respuestas: `200` con `{ok, detail}` (un canal que no existe es `ok: false`, no un error), `400` una orden que no está en la lista,
`401` sin token o token malo, `403` apagado, nivel insuficiente o desde otro equipo u otro sitio, `503` si la ventana no está
conectada, `504` si no contesta en 8 s.

**Cómo funciona por dentro:** la página publica una foto de su estado cada vez que cambia (y cada 30 s aunque no cambie) y escucha
las órdenes por un flujo de eventos del servidor; contesta cada una, y la respuesta es lo que recibe el cliente. Las rutas
de la página (`/api/control/status`, `events`, `state`, `result`, `token`) son del mismo origen que el resto de la API y
no son para clientes. **Si hay más de una ventana abierta** (la aplicación y una pestaña del navegador), todas ejecutan
la orden.

**Lo que se hizo por seguridad**, y lo que no:

- Apagado por defecto; con él apagado, ni siquiera la ventana publica nada. Cada nivel por separado.
- La orden pasa por una **lista cerrada** con los tipos y límites comprobados en el servidor y otra vez en la página; no hay
  forma de pedir otra cosa. **No se puede tocar ajustes, plugins ni salir por aquí**, y no hay nada del nivel de desarrollo.
- La foto del estado **no lleva direcciones de streams**: solo qué canal hay en cada casilla, el volumen y el modo.
- El token se compara en tiempo constante, se puede cambiar (el anterior deja de valer al momento) y el archivo se crea
  con permisos de usuario. **Protege de páginas web y de otros usuarios del equipo, no de otro programa que corra con tu
  usuario** (ese puede leer el archivo): es una herramienta local, y así queda dicho en la pestaña.
- Las peticiones de otro origen o con otro `Host` se rechazan como en el resto de la API, aunque lleven el token.
- Una etiqueta azul **«IA conectada»** aparece mientras un cliente ha pedido algo en el último minuto; pasando el ratón
  por encima salen sus últimas acciones. Esas acciones se guardan además en el registro del servidor.
- **Lo que no resuelve:** los nombres de canal y los títulos de programa que lee la IA vienen de internet y pueden traer
  instrucciones escondidas. Por eso el nivel de partida es solo leer, y el control es una decisión aparte.

Se ha comprobado con la aplicación real en Windows: un cliente externo con el token pone canales, cambia volumen y
multivisión, y el estado lo refleja; con el nivel de leer, una orden da `403`; sin token o con otro sitio, se rechaza.
**No se ha comprobado** en macOS y Linux, ni con una petición real desde otro equipo con `--lan` (hay una prueba con un
manejador de mentira).

### El servidor MCP, lo que hay hoy

Hecho en la fase C: **lectura, control y escribir plugins de desarrollo**. Envuelve el bus de control: cada herramienta
acaba en una llamada que el bus ya comprueba (token, nivel, lista cerrada de órdenes). La administración de ajustes y de
plugins normales no existe todavía (ver [más abajo](#después-el-servidor-mcp-lo-que-falta)).

| Herramienta | Nivel | Qué hace |
|---|---|---|
| `tdt_state` | leer | Qué está viendo el usuario: lista, modo, qué canal hay en cada casilla, volumen |
| `tdt_search_channels` | leer | Busca canales y emisoras que se pueden reproducir (`query`, `kind`, `limit`) |
| `tdt_guide` | leer | Lo que dan ahora y lo siguiente en un canal (`channel`) |
| `tdt_ad_markers` | leer | Las últimas marcas de pausa publicitaria (sin direcciones) |
| `tdt_play` | controlar | Pone un canal (`channel`) |
| `tdt_set_kind` | controlar | Cambia de lista: `tv`, `radio` o `u7d` |
| `tdt_set_volume` | controlar | Volumen de 0 a 1 |
| `tdt_mute` | controlar | Silencia o da sonido (`on`) |
| `tdt_multiview` | controlar | De 1 a 4 canales en multivisión, con `rotate_seconds` opcional |
| `tdt_headers_get` | leer | Las cabeceras de petición de un canal (`channel`, id o nombre); de una credencial solo se ve que está puesta |
| `tdt_rules_get` | leer | Las reglas de automatización del usuario («cuando pase esto, haz aquello»), cada una con su frase; ver [REGLAS.md](REGLAS.md) |
| `tdt_commands` | leer | La **lista única** de órdenes (poner canal, volumen, silencio, multivisión, aviso) y de eventos (otro canal, otro volumen, otra lista, un programa que empieza), con sus argumentos y el permiso que necesita un plugin para oírlos |
| `tdt_plugin_calls` | leer | Las últimas llamadas de los plugins a la aplicación (`id` y `limit` opcionales): qué plugin, qué método, cómo acabó (`ok` o el código de error) y cuánto tardó; **sin argumentos ni respuestas**. Para depurar un plugin |
| `tdt_events` | leer | Lo último que ha pasado en la ventana (`limit`, `name`), el más reciente primero; lo que hizo una regla viene marcado con `cause: rule` |
| `tdt_rules_set` | controlar | Sustituye todas las reglas. Se comprueban antes de molestar y **una ventana del sistema se las enseña al usuario**, con lo que cambia; solo en la aplicación de escritorio |
| `tdt_headers_set` | plugins | Pone, cambia o quita cabeceras de un canal (`null` quita). **Pide confirmación al usuario** en una ventana del sistema, con cada cambio a la vista; solo en la aplicación de escritorio |
| `tdt_plugins` | leer | **Los plugins con permisos**: si están activados, su estado (en marcha, arrancando, no responde, parado), qué permisos piden y cuáles ha quitado el usuario, dónde se muestran, lo que han hecho (llamadas, errores, reinicios, red, datos guardados) y sus problemas |
| `tdt_plugin_logs` | leer | Las últimas líneas del Registro de un plugin con permisos |
| `tdt_plugin_api` | leer | La especificación exacta de su API (`tdtlocal/static/plugin-api.json`), entera o un método |
| `tdt_plugin_read` | plugins | Los archivos de un plugin con permisos de la carpeta del usuario, para cambiarlo |
| `tdt_plugin_write` | plugins | **Escribe un plugin con permisos** (`null` borra un archivo). Con `dry_run` comprueba el manifest, la sintaxis y da avisos sin escribir ni molestar. Sin él, **la ventana del usuario enseña los permisos (con su riesgo) y el código**; escribir no activa nada. Si está activado y los permisos no cambian, se recarga solo |
| `tdt_plugin_config` | plugins | Cambia los ajustes que un plugin declara en su manifest (`tdt.settings`): `{ajuste: valor}`. Se comprueban antes de molestar y **el usuario ve cada cambio en una ventana del sistema**; `tdt_plugins` dice qué ajustes tiene cada plugin y su valor actual |
| `tdt_plugin_enable` | plugins | Pide al usuario que active un plugin. **Pide confirmación** (ventana nativa con lo que podrá hacer y el riesgo) |
| `tdt_plugin_disable` | plugins | Apaga un plugin. No pregunta: quitar poder es seguro |
| `tdt_plugin_permission` | plugins | Quita un permiso suelto (`on: false`, sin preguntar) o lo devuelve (`on: true`, **pide confirmación**) |
| `tdt_dev_plugins` | plugins | Lista los plugins de desarrollo y su estado |
| `tdt_dev_read` | plugins | Los archivos de un plugin de desarrollo |
| `tdt_dev_write` | plugins | Crea o cambia archivos (`null` borra). Con `dry_run` solo comprueba. **Pide confirmación al usuario** |
| `tdt_dev_logs` | plugins | Las últimas líneas del Registro de ese plugin, para depurar |
| `tdt_dev_activate` | plugins | Pide al usuario que lo active. **Pide confirmación** |

Además, los recursos `tdt://state` (el mismo estado), `tdt://docs/dev-plugins` y `tdt://docs/plugins` (las guías que la IA lee antes de
escribir) y `tdt://docs/plugin-api` (la especificación de la API). Con el nivel «leer», `tools/list` **solo enseña las doce de lectura**
(con «controlar», las dieciocho; con «plugins», las treinta), y aunque se llame a una de control por su nombre el servidor la rechaza. **Todo
lo que se puede hacer con los plugins se puede ver y consultar por aquí**: es una regla de diseño, no un añadido.

**Cómo conectarlo.** Primero, **enciende el acceso** (Ajustes ▸ Acceso de IAs). Después, hay dos formas:

1. **Por entrada y salida estándar (recomendada):** el cliente arranca `tdt-local mcp`; el servidor busca solo la dirección y el
   token en la carpeta de datos de la aplicación abierta (o en `TDT_URL`, `TDT_PORT` y `TDT_CONTROL_TOKEN`). Con la app instalada
   el programa es `resources/server/tdt-local-server` (`.exe` en Windows) con el argumento `mcp`; desde el código,
   `python -m tdtlocal.mcp`. En un cliente que lea la configuración habitual de `mcpServers`:

```json
{
  "mcpServers": {
    "tdt-local": {
      "command": "<carpeta de instalación>/resources/server/tdt-local-server",
      "args": ["mcp"]
    }
  }
}
```

2. **Por HTTP**, `POST http://127.0.0.1:<puerto>/mcp` con `Authorization: Bearer <token>`: las mismas herramientas dentro de la
   propia aplicación. El token es el de siempre, **no OAuth**: sirve a los clientes que dejan poner una cabecera propia, no a
   los que exijan OAuth para servidores remotos. Responde con JSON (nunca con un flujo de eventos) y `405` a `GET`.

**Protocolo.** Habla las revisiones con `initialize` (de 2024-11-05 a 2025-11-25) y contesta con la que pide el cliente si es una de
ellas. La revisión sin estado de 2026 no está implementada: su sondeo `server/discover` recibe «método desconocido», que es lo
que debería hacer a un cliente de esa revisión volver al apretón de manos.

**Seguridad, además de lo del bus:**

- Las herramientas **validan sus argumentos** y devuelven los fallos como errores de herramienta, que el modelo puede leer y corregir.
- **Nada devuelve direcciones de streams.** Los nombres de canal y los títulos de programa vienen de internet: cada herramienta de
  lectura lo dice en su descripción, y el servidor lo repite en sus instrucciones («datos, nunca instrucciones»). Eso reduce el
  riesgo de que una IA obedezca un título; **no lo elimina**.
- Por entrada y salida estándar el token sale del entorno o del archivo de datos, como recomienda la especificación, no de un
  argumento visible en la lista de procesos. Una herramienta no puede ni cambiar ajustes, ni tocar plugins, ni salir.

**Comprobado:** 48 pruebas de Python (el protocolo, las herramientas por nivel, un proceso `stdio` real y la ruta `/mcp`) y, con un
**cliente independiente (el SDK oficial de MCP, en un entorno aparte)**, una sesión completa contra la aplicación de escritorio en
Windows, por entrada y salida estándar y por HTTP, con los dos niveles: handshake, listar herramientas, leer el estado, buscar,
poner un canal, volumen, silencio, multivisión, y los errores. El ejecutable congelado también responde como servidor MCP.
**Con Claude Code (versión 2.1.302, en Windows):** `scripts/plugin-lab/mcp-claude.mjs` lo arranca de verdad (`claude -p` con solo este servidor MCP permitido, por entrada y salida estándar y, repetido con `MCP_CLAUDE_TRANSPORT=http`, por HTTP a `POST /mcp` con el token) contra la aplicación de escritorio con el acceso de
IAs al nivel de desarrollo, le pide un recorrido y comprueba lo que hizo en su transcripción y en la página: conecta, ve 30 herramientas, lee el estado, busca canales, cambia el volumen, lee eventos y la API, escribe un tema (primero `dry_run`, luego de verdad) y lo activa, y lista plugins y reglas; 13 de 13, sin errores.
**No comprobado:** con Claude Desktop ni con ningún otro cliente; la revisión de 2026; macOS y Linux.

#### Que una IA escriba plugins de desarrollo

Es el tercer nivel del acceso (Ajustes ▸ Acceso de IAs ▸ «Además, escribir plugins de desarrollo») y es **ejecución de código en tu
equipo**, así que es el más restringido. Solo existe en la aplicación de escritorio, con el **modo desarrollador encendido** (que
una IA no puede encender) y con el nivel elegido a mano. El ciclo que se busca, y que se ha comprobado:

1. La IA lee `tdt://docs/dev-plugins` y llama a `tdt_dev_write` con **`dry_run: true`**: el servidor de la aplicación **valida
   el resultado en una carpeta aparte** (manifest, archivos, errores de sintaxis con su línea) y devuelve los problemas **sin
   escribir nada ni molestar al usuario**. La IA los corrige y repite.
2. `tdt_dev_write` sin `dry_run` **enseña al usuario, en un diálogo nativo de la aplicación, qué cambia y el código nuevo**, con
   un botón «Ver los archivos» que abre el resultado entero para leerlo. **Solo si acepta** se toca la carpeta del plugin. Si el plugin
   ya está activado, el código nuevo corre en cuanto acepta, y el diálogo lo avisa en mayúsculas.
3. `tdt_dev_activate` es **otra pregunta**, con el código a la vista. Hasta que el usuario acepta, el plugin no corre.
4. `tdt_dev_logs` deja a la IA leer lo que el plugin ha escrito y sus errores; al editar un plugin activo, **se recarga solo**.

Qué impide los abusos:

- **El usuario decide cada vez**, en un diálogo del proceso principal que ninguna página puede pulsar. Una IA que escriba código
  sin que él lo vea no puede: ni escribir, ni activar, ni encender el modo desarrollador.
- **Una pregunta a la vez**: mientras una espera, otra escritura o activación se rechaza («ya hay una pregunta esperando»), para que
  una IA no apile diálogos.
- **Nombres cerrados**: la carpeta del plugin y cada archivo se validan en el servidor y otra vez en la aplicación (sin `..`, sin
  rutas absolutas, sin enlaces, hasta 3 niveles, 12 archivos, 64 KB cada uno, 256 KB en total, solo `.js .mjs .json .css .html
  .txt .md`). Una prueba con el cliente independiente comprueba que `../fuera.js` y un id `..` no escapan de la carpeta.
- **El Registro** anota los cambios aceptados y las activaciones (con el nombre de los archivos, nunca su código). La etiqueta
  «IA conectada» sigue avisando.
- **Lo que no impide:** que el usuario acepte código malo sin leerlo. El diálogo enseña el principio de cada archivo y el botón
  abre el resto, pero un diálogo no obliga a leer. Y el código de un plugin activo sigue teniendo los poderes de la aplicación.

Cosas de comportamiento que conviene saber: la orden espera hasta 3 minutos a que el usuario conteste (el cliente MCP puede cansarse
antes y la pregunta seguirá en pantalla); tras activar un plugin con parte de página, la ventana se recarga sola (la orden que
llega justo en ese instante se le entrega a la página que se reconecta); y para las pruebas con la ventana a mano hay
`TDT_DEV_CONFIRM=yes`, que **solo vale con la aplicación sin empaquetar** y contesta «sí» a las preguntas.

**Comprobado:** pruebas de Python (las órdenes, los niveles, los límites, la entrega de órdenes a una página que se recarga) y de
JavaScript (el módulo que valida, prepara y escribe, con las preguntas sustituidas) y una sesión completa con el cliente
independiente (SDK oficial de MCP) contra la aplicación de escritorio real: guía, `dry_run` con error de sintaxis (con su línea),
nombres que escapan rechazados, escribir, activar, ver en el Registro el plugin corriendo en la página y en el proceso principal,
editarlo y verlo recargarse, y las negativas con el nivel de controlar y con el modo desarrollador apagado.
**No comprobado:** el diálogo nativo de verdad (las pruebas lo contestan solas: nadie lo ha visto ni pulsado en esta máquina), con
Claude Desktop ni otros clientes (con Claude Code sí: ver arriba), y macOS y Linux.

### Después: el servidor MCP, lo que falta

Un servidor MCP colgado de ese bus, **apagado por defecto**. Tres niveles, cada uno se activa por separado en Ajustes:

| Nivel | Herramientas (propuesta) |
|---|---|
| **Lectura** | buscar y listar canales, guía, marcas de anuncios, estado del reproductor, estado de plugins, leer el Registro |
| **Control** | poner un canal, multivisión, volumen, buscar en U7D |
| **Administración** | crear, editar, validar, recargar y activar plugins **normales**; ver sus registros; cambiar ajustes; capturar la pantalla |
| **Desarrollo** | escribir y activar plugins **de desarrollo** (código sin aislar). Aparte de administración, con el modo desarrollador encendido y confirmación mostrando el código en cada escritura |

**Recursos** para el modelo: la documentación de la API de plugins (`tdt://docs/plugins`), con ejemplos pensados para que
la lea una IA, y el manifest de cada plugin. **Prompts** de arranque («hazme un plugin que…»).

**Transporte y autenticación:** a decidir con la especificación de MCP vigente delante **(por comprobar:** qué transporte
(proceso por entrada y salida estándar, o HTTP local) y qué esquema de autenticación recomienda ahora). Lo que sí es firme:
solo `127.0.0.1`, con **token** que genera la aplicación y se puede regenerar.

### El ciclo que lo hace especial

```
la IA escribe un plugin  →  lo valida  →  la app muestra los permisos y el usuario concede
        ↑                                                  ↓
   lee su registro y lo corrige   ←   lo activa y lo recarga
```

Para que ese ciclo sea posible, el nivel de administración incluye `plugins_validate` (comprueba el manifest y los permisos
sin ejecutar nada) y `plugins_logs` (solo los del plugin). Una **captura de pantalla** de la ventana ayuda muchísimo a
depurar una interfaz, pero enseña lo que estás viendo: va en administración y con confirmación.

### Lo delicado

- **Un MCP es control remoto del programa por un modelo.** Apagado por defecto; token; solo local; cada nivel aparte; un
  **indicador visible** «IA conectada» y un **registro de lo que hizo** (en el Registro, con su origen).
- **Confirmación en la propia aplicación** para lo que cambia lo que se ejecuta o la configuración: activar un plugin, cambiar
  ajustes, salir, capturar pantalla. La herramienta **espera a que el usuario acepte en la app**; no se fía de lo que
  diga el modelo, ni de que el cliente tenga un «¿seguro?» propio.
- **Inyección de instrucciones.** Lo que devuelve el servidor (nombres de canal, guía, títulos de programas, el nombre de un
  plugin) viene de internet o de un tercero, y acaba en el contexto del modelo. **No se puede filtrar de forma fiable.** La
  defensa es el mínimo privilegio (que lectura y control no puedan tocar plugins ni ajustes) y las confirmaciones, no
  intentar detectar frases malas.
- **Un plugin no puede hablar por la IA ni con su token.** El token del MCP no está disponible para ningún plugin.

## Fuentes de reproducción como plugins (YouTube, Twitch, Atresplayer)

**Dirección decidida, sin código todavía.** Hoy el núcleo sabe embeber YouTube (un `<iframe>` con órdenes por `postMessage`) y
el reproductor de Atresplayer, y un PR propone Twitch cargando su SDK. La idea es sacar los tres del núcleo: cada uno sería un
plugin de tipo **fuente de reproducción**, que declara a qué servidor se conecta y que el usuario aprueba al activar, como
cualquier otro permiso. Con eso, el núcleo no ejecuta código de terceros en la página (el SDK de Twitch correría con los
privilegios de la página: ajustes, acceso de IAs y, en la aplicación de escritorio, el puente con el sistema) y cada servicio
nuevo es un plugin y no una rama más de `tile.js`.

**Lo que falta en la API de hoy** (la fase A solo da paneles flotantes):

1. **Un permiso para embeber un servidor concreto**, por ejemplo `embed:player.twitch.tv`: añade ese servidor, y solo ese, a
   los marcos (y, si hace falta, al script) de la caja de ese plugin. Se enseña al activar como el resto.
2. **Poder ser una fuente de canal**: el plugin dice qué enlaces reconoce (`https://www.twitch.tv/nombre`), y la aplicación le
   cede una casilla (o su zona) en lugar de montar un `<video>`. El plugin recibe las órdenes de audio (volumen, silencio,
   «esta casilla es la activa») y devuelve el estado (listo, desconectado, error), para que el plan de fuentes y la
   multivisión sigan funcionando.
3. **Una forma de decir qué hace cada fuente que un `<video>` normal sí hace** y esta no: no hay ecualizador local, ni
   transcripción, ni marcas de anuncios. El plugin lo declara y la interfaz lo muestra, para no prometer lo que no hay.

**Lo que hay que averiguar antes de fijar nada** (marcado **por comprobar**):

- Si **Twitch acepta su reproductor dentro de la caja de un plugin**: pide `parent=<dominio>` y mira la cadena de marcos que lo
  contiene, y la caja es un marco sin origen propio servido desde `tdt-plugin://<id>/`. Si no lo acepta, hay que pensar otra
  forma de dar la casilla (por ejemplo, que el marco del servicio cuelgue de la página, y el plugin solo lo gestione) y lo que
  eso cuesta en aislamiento.
- Cómo se sigue manejando **YouTube** (`enablejsapi` y `postMessage`), que no necesita script de terceros: el cambio a plugin
  tendría que ser tan seguro como hoy y no empeorar el audio ni el arranque.
- Cuánto tarda en **arrancar una fuente dentro de un plugin** frente a hoy, y qué pasa con la **recarga** de la casilla.
- Que quien instale un plugin de fuente sepa que **ese servicio verá su dirección IP y su sesión**: es lo que cuesta ver
  Twitch o YouTube, y se dice en la pregunta de activación.

**Mientras tanto:** el núcleo no admite fuentes nuevas con script de terceros. Un PR que lo haga (como el de Twitch, que está
muy bien hecho) se deja abierto como referencia y se recoge cuando exista la API: el reconocimiento de canales, el control de
audio por el SDK y la detección de canal desconectado se reutilizan casi enteros.

## Distribución

Hoy: una **carpeta** que se copia a la carpeta de plugins, o un archivo **`.tdtplugin`** (un zip reproducible: la misma carpeta da
los mismos bytes y el mismo SHA-256) que la aplicación muestra (manifest, permisos, huella) **antes** de copiarlo, y que no se activa
hasta que el usuario lo decide, con otra pregunta. Falta **un enlace a git/zip** que la propia aplicación descargue y muestre
lo mismo **antes** de activar nada. Sin tienda por ahora, sin actualizaciones automáticas: cada
versión nueva es una decisión del usuario, y si pide más permisos, se vuelve a preguntar.

## Fases

| Fase | Qué | Cómo se sabe que está |
|---|---|---|
| **0** (hecha) | Plugins de desarrollo: modo desarrollador, carpeta propia, alcances `page` y `main`, recarga en caliente, aviso permanente | Un plugin de ejemplo cambia algo de la interfaz y otro corre en el proceso principal; con el modo apagado, o desde otra carpeta, no se carga |
| **A** (hecha; ver [HACER-PLUGINS.md](HACER-PLUGINS.md)) | Permisos declarados, marco aislado, SDK (`tdt.player`, `channels`, `epg`, `ui`, `storage`, `net`), panel, empaquetar e instalar `.tdtplugin` con su hash | Cuatro plugins de ejemplo (`ahora`, `tiempo`, `pantalla` y un `teletexto` completo, estos dos sobre la pantalla del reproductor) funcionan en la aplicación real; un plugin hostil que intenta escapar de la caja no lo consigue; uno que pide algo no concedido falla; el permiso se comprueba en cada llamada. **Falta:** `tdt.events` de anuncios (marcas SCTE), instalar desde una dirección web, firmas de autor, que una IA escriba plugins con permisos por el MCP, y comprobarlo en macOS y Linux |
| **B** (hecha) | Bus de control: estado y órdenes, con token | Un cliente de prueba cambia de canal y lee el estado; sin token, 401 |
| **C** (lectura, control, administración de plugins y plugins de desarrollo hechos; **comprobado con Claude Code**; falta con Claude Desktop y otros clientes) | MCP: lectura, luego control, luego administración | Un cliente MCP real (Claude Desktop o Claude Code) lista canales y cambia de canal; el registro anota lo que hizo (**hecho con Claude Code**) |
| **D** | Plugins de datos; Atresplayer como el primero | U7D de Atresplayer sale del núcleo sin cambiar lo que ve el usuario |
| **F** | Fuentes de reproducción como plugins: YouTube, Twitch y el reproductor de Atresplayer salen del núcleo | Un plugin de Twitch reproduce un canal en una casilla, con silencio y volumen en multivisión, sin que el núcleo cargue ningún script de terceros; YouTube sigue funcionando igual con el mismo audio y arranque |
| **E** (hecha para plugins de desarrollo) | Herramientas de autoría para IAs y su documentación | Una IA crea un plugin desde cero y lo deja funcionando sin tocar archivos del programa |

Cada fase se puede publicar sola. **A y B no dependen del MCP**, y B es útil aunque no se haga C.

**Por qué la 0 va primero:** es la más simple (no hay aislamiento ni permisos que construir) y desbloquea ya a quien
quiera experimentar, y sirve para **descubrir qué API hace falta de verdad** antes de congelarla en la A. El riesgo es
que la gente se apoye en `api: 0` como si fuera estable: por eso lleva ese número y se dice en cada sitio. El alcance
`server` (Python) queda para después de la 0, cuando se compruebe lo del servidor congelado.

## Decisiones abiertas (con lo que recomiendo)

1. **Modelo de confianza.** Permisos declarados y concedidos por el usuario (**recomendado**) frente a confiar en todo como un
   *userscript*. La segunda es más simple de hacer y mucho más difícil de defender cuando alguien comparta un plugin malo.
2. **Dónde corren.** Solo JavaScript y solo en escritorio (**recomendado**) frente a también Python en el servidor (más
   potencia, pero un plugin en Python corre con los permisos de todo el programa y no se puede aislar bien). Para quien quiera Python, el tipo de desarrollo lo permite, sin aislamiento y a propósito.
3. **MCP.** Apagado por defecto y por niveles (**recomendado**) frente a un solo interruptor.
4. **Distribución.** Carpeta y enlace a git, sin tienda (**recomendado** por ahora).
5. **¿Puede un plugin aportar herramientas al MCP?** Muy potente (la IA gana capacidades nuevas con cada plugin) y la
   superficie de inyección de instrucciones se multiplica. Mi recomendación es **no en la primera versión**.
6. **Plugins de desarrollo.** ¿Un tipo aparte, sin aislamiento, con modo desarrollador y carpeta propia (**recomendado**), o
   un permiso más («puede todo») que se concede como los demás? Lo segundo lo hace parecer uno más del montón; lo primero
   lo separa a propósito.
7. **¿El modo desarrollador se recuerda entre arranques?** Recomiendo que sí, con el aviso permanente; la alternativa
   (preguntar en cada arranque) es más segura y muy pesada para quien lo usa a diario.
8. **¿Se hace antes la revisión de seguridad de `desktop/`?** Hoy el puente entre la página y el sistema ya es la parte
   más delicada; esta propuesta la amplía mucho. Recomiendo revisarla **antes** de la fase A.

## Lo que hay que averiguar antes de fijar nada

- Si el marco aislado con protocolo propio funciona con el CSP estricto de la página.
- Qué transporte y qué autenticación recomienda ahora la especificación de MCP para un servidor local.
- Cuánto cuesta mantener la API de plugins estable: cada cosa que se expone se convierte en una promesa.
- Cómo se enseña un permiso de red sin que el usuario lo acepte sin leer (esto es de diseño de interfaz, no de código).

Relacionado: en la [hoja de ruta](../ROADMAP.md), «Reproductor ampliable con plugins» (cada casilla como una cadena con
módulos) sería un caso particular de los plugins de interfaz.
