# Aplicación de escritorio con ventana propia y plugins (esbozo de diseño)

> **Estado: en `desktop/`, empaquetada desde la 1.3.0.** Ventana de Electron con el servidor congelado dentro, bandeja,
> plugins (con el puente de Atresplayer como primero) y Registro. **La sección «Plugins» de abajo es el diseño del primer prototipo; el estado actual de los plugins (cuatro clases, ganchos, temas, capas, modo seguro) está en [PLUGINS.md](PLUGINS.md#dónde-estamos-hoy-150) y [HACKEABLE.md](HACKEABLE.md).** Los instaladores la llevan; sigue siendo joven (sin
> firmar, sin actualizaciones automáticas, probada a fondo solo en Windows). Se puede probar desde el código
> ([Probarlo](#probarlo)); el resto de este documento es el diseño y marca lo que falta.

## Por qué

Hoy la aplicación instalada (`tdtlocal/desktop.py`, empaquetada con PyInstaller) arranca el servidor sin consola y **abre
el navegador del usuario**. Funciona, pero tiene dos límites:

1. **El puente con Atresplayer** (`tools/puente-atresplayer`) obliga a cargar una extensión en el modo de desarrollador
   del navegador. Es un paso que mucha gente no va a dar.
2. **La app no controla la ventana**: no hay icono de bandeja, cerrar la pestaña no para el servidor (de ahí el botón
   «Salir») y no se puede ofrecer nada que dependa del motor del navegador.

La idea es una **ventana propia** (Chromium integrado) y, aparte, un **sistema de plugins** donde el puente sea el
primero. Los plugins que tocan sitios ajenos quedan separados del núcleo.

## Lo que no se quiere

- Que TDT local deje de funcionar en un navegador normal: **el modo actual (servidor + navegador) se mantiene**, y la
  extensión del puente sigue valiendo para quien no instale la app.
- Reescribir el servidor ni la interfaz. La ventana carga la misma página de `127.0.0.1`.
- Un sistema de plugins abierto a código remoto. Los plugins son carpetas locales que el usuario pone y activa.
- Saltarse restricciones de sitios ajenos por defecto (ver [Mediaset](#mediaset)).

## Opciones para la ventana

| Opción | Peso aprox. | Mismo motor en los tres sistemas | Inyectar código en iframes ajenos | Comentario |
|---|---|---|---|---|
| **Modo app de Chrome/Edge** (`--app=URL`) | 0 | Sí (el del usuario) | Con la extensión | Ya está en la hoja de ruta. Sin dependencias, pero no quita el paso de cargar la extensión. |
| **pywebview** | pocos MB | No (WebView2 / WebKit) | Depende del sistema, poco documentado | Pequeño y en Python, pero el comportamiento cambia por plataforma. |
| **Electron** | ~100 MB | **Sí** (Chromium propio) | **Sí**, desde la app | Más pesado, pero igual en todos los sistemas y con control completo. |
| Tauri | pocos MB | No (WebView2 / WebKit) | Depende del sistema | Añade la cadena de Rust. |

**Propuesta:** Electron para la ventana propia, porque es lo único que da el mismo motor y la inyección en marcos
ajenos en los tres sistemas sin depender del navegador del usuario. Antes, y barato, el modo app de Chrome/Edge de la
hoja de ruta, que ya da ventana sin barra de direcciones.

Por comprobar: que Electron cargue el `manifest.json` y los scripts del puente tal cual (sus extensiones de Chrome son
parciales y los scripts de contenido con `all_frames` no siempre se comportan igual). Si no, se inyectan los archivos
directamente desde el proceso principal (ver [Cómo se cargan](#cómo-se-cargan)); el protocolo de `postMessage` no cambia.

## Arquitectura

```
┌──────────────────────────── aplicación instalada ────────────────────────────┐
│  Electron (proceso principal)                                                │
│   ├─ arranca el servidor Python (el mismo ejecutable de PyInstaller),        │
│   │   sin consola, y espera a que /api/version responda                      │
│   ├─ ventana → http://127.0.0.1:<puerto>/    (la interfaz de siempre)        │
│   ├─ icono de bandeja: Mostrar · Plugins · Salir (para el servidor)          │
│   └─ cargador de plugins → inyecta sus scripts en los marcos que coinciden   │
│                                                                              │
│  Servidor Python (tdtlocal)  — sin cambios, salvo reconocer a la app         │
└──────────────────────────────────────────────────────────────────────────────┘
```

- El servidor sigue siendo el de siempre, y el proceso principal lo arranca y lo para. Si ya hay una instancia en el
  puerto, como hoy, la ventana se conecta a esa.
- La página no sabe si está en el navegador o en la app. La app se anuncia para poder mostrar lo que le corresponde
  (por ejemplo «plugins» en Ajustes), no para cambiar el comportamiento.
- «Salir» desde la bandeja o al cerrar la última ventana (ajustable) para el servidor.

## Plugins

> **Plugins con permisos.** Además de los de scripts que describe esta sección, hay plugins **con panel propio y
> permisos declarados**, que corren aislados: se hacen, empaquetan e instalan desde Ajustes ▸ Plugins. Guía completa en
> [HACER-PLUGINS.md](HACER-PLUGINS.md).

Un plugin es **una carpeta** con un `manifest.json` y sus scripts, en `<datos>/plugins/<nombre>/`. El puente de
Atresplayer ya es casi uno: la misma carpeta se usa como extensión de navegador y como plugin de la app.

```json
{
  "manifest_version": 3,
  "name": "TDT local · puente con Atresplayer",
  "version": "1.1.0",
  "description": "Cuenta a TDT local cuándo hay publicidad en el reproductor incrustado y le deja controlar su sonido.",
  "content_scripts": [
    {
      "matches": ["https://www.atresplayer.com/embed/live/*", "https://atresplayer.com/embed/live/*"],
      "js": ["audio-chain.js", "puente.user.js"],
      "all_frames": true
    }
  ]
}
```

(Es exactamente el `manifest.json` de la extensión del puente: el formato de `content_scripts` de las extensiones de
Chrome, sin campos propios, para que **la misma carpeta valga como extensión de navegador y como plugin de la app**.
`run_at` se ignora: los scripts corren cuando la página está lista. Un manifiesto que pida `permissions`,
`host_permissions` o `background` se rechaza, y los patrones demasiado amplios o locales (`<all_urls>`, `*://*/*`,
`localhost`, `127.0.0.1`) también.)

### Cómo se cargan

- El cargador solo inyecta en marcos cuyo origen coincide con `matches` y que están dentro de la ventana de TDT local.
- Los scripts se leen del disco; **nunca se descargan de una dirección remota**.
- Cada plugin trabaja en un mundo aislado del de la página, como los scripts de contenido de una extensión.
- El protocolo con la página sigue siendo `postMessage` (`tdt-bridge` / `tdt-local`), comprobando origen y emisor, como
  hoy.

### Qué puede y qué no puede un plugin

| Capacidad | Por defecto | Notas |
|---|---|---|
| Leer y escribir en los marcos que coinciden con `matches` | Sí, tras activarlo | Es todo lo que hace el puente. |
| Hablar con la página de TDT local por `postMessage` | Sí | Solo con la ventana que lo incrusta. |
| Peticiones de red | **No** | Haría falta declararlo y que el usuario lo acepte. |
| Cambiar cabeceras de respuesta de otros sitios (`frame-ancestors`, CSP…) | **No** | Capacidad aparte, ver [Mediaset](#mediaset). |
| Leer cookies, almacenamiento o ventanas que no son sus marcos | **No** | |

### Activación

- **Todos los plugins están desactivados por defecto**, también el puente. Se activan en **Ajustes ▸ Plugins**, que
  muestra qué sitios toca cada uno, qué capacidades pide y de dónde viene.
- Los plugins que lleva la propia app (el puente) se firman con la app; los que añada el usuario aparecen con un aviso
  de que son código que ejecuta él.
- Un plugin que pida una capacidad por encima de las de la tabla de arriba la muestra en un diálogo antes de activarse.

## Mediaset

Mediaset Infinity impide que su reproductor se incruste en otra página (`frame-ancestors`). Con una ventana propia sería
técnicamente fácil quitar esa cabecera, pero es **saltarse una restricción que el sitio puso a propósito**. No va en la
app base. Si se hace, será un plugin aparte que:

- esté **desactivado por defecto** y diga claramente qué cambia;
- se limite a los dominios de Mediaset estrictamente necesarios;
- pida la capacidad de cambiar cabeceras como un permiso aparte.

Una alternativa que no toca cabeceras: abrir su reproductor en **una ventana propia de la app** (no incrustado) y usar el
mismo enfoque del puente para leer el aviso y controlar el sonido. Se evaluaría cuando toque. Por ahora Mediaset queda
fuera, como en la versión 1.1.0.

## Seguridad

- La ventana solo carga `127.0.0.1` (y los marcos que ya admite la política de seguridad de la página). Enlaces a otros
  sitios se abren en el navegador del sistema, no en la ventana.
- Electron con `contextIsolation` activado, sin integración de Node en las páginas y con el *sandbox* de Chromium.
- El servidor sigue limitando las rutas de escritura al equipo local y comprobando `Host`/`Origin`.
- Los plugins no tienen acceso al servidor Python más allá de la página.
- Habrá que **actualizar Electron con regularidad** (es el coste principal de seguridad de esta opción) y la CI debe
  avisar cuando una versión de Chromium quede atrás.

## Empaquetado y distribución

- Hoy: PyInstaller → instaladores (`packaging/build.py`, `release.yml`). Con Electron, el ejecutable de PyInstaller se
  incluye **dentro** de la app y es lo que el proceso principal arranca; los instaladores siguen siendo cuatro, uno por
  sistema.
- Tamaño: unos 100 MB más por el Chromium incluido.
- Firma: igual que hoy, sin firmar. Las pantallas de aviso de Windows y macOS siguen apareciendo.
- **Decisión: cambio completo a Electron.** Los instaladores pasan a ser la app Electron, sin un segundo paquete ligero.
  Lo que se conserva es el **servidor Python** (dentro de la app, y también desde la línea de comandos o `pip` para quien
  lo quiera en su navegador o en un servidor de casa con `--lan`). Lo que cambia es solo la cáscara: quién abre la
  ventana, la bandeja y los plugins.
- **No se reescribe el servidor en Node.** Sería rehacer proxy, listas, guía, SCTE-35 y transcripción sin ganar nada
  para el usuario, y se perderían las pruebas actuales. Si más adelante se quiere, es otra decisión.

## Probarlo

Hace falta Python (como para ejecutar TDT local desde el código) y Node 20 o superior. Desde la raíz del repositorio:

```bash
cd desktop
npm install
npm start
```

![Ajustes ▸ Plugins](img/plugins.png)

La primera vez descarga el Chromium de Electron (unos 100 MB). Se abre la ventana con TDT local, aparece un icono en la
bandeja, y **Ajustes ▸ Plugins** (pestaña que solo existe en la app) lista los plugins que encuentra, **todos
desactivados**, con lo que hace cada uno, en qué sitios actúa y de dónde viene; el menú **Plugins** de la bandeja hace lo
mismo. Los plugins son los que añadas tú en
`<datos de la app>/plugins/<nombre>/` (la carpeta `desktop` dentro de los datos de TDT local, ver
[Dónde guarda las cosas](#dónde-guarda-las-cosas)), los de `TDT_PLUGINS_DIR` y,
en desarrollo, las carpetas con `manifest.json` de `tools/` (el puente de Atresplayer). Desde la pestaña, marcar un
plugin lo guarda y ofrece «Recargar ahora» (los scripts se inyectan al cargar la página); desde la bandeja recarga solo.
La pestaña tiene además «Abrir la carpeta de plugins» y «Buscar de nuevo» (para plugins recién copiados). El botón «Salir»
de la página cierra la app entera.

**Cómo habla la página con la app:** el `preload.cjs` pone `window.tdtDesktop` (listar, activar, buscar de nuevo, abrir
la carpeta, recargar) solo en la página de TDT local, nunca en un marco de dentro. Aun así el proceso principal
comprueba en cada llamada que viene de esa página de nuestra ventana (marco superior, origen del servidor), y a la
página solo le cuenta nombre, descripción, sitios y problemas de cada plugin: no sus scripts. Fuera de la app
(`window.tdtDesktop` no existe) la pestaña no aparece.

**Comprobado de punta a punta** (con un guion que abre la ventana por el protocolo de depuración, pone el reproductor
real de Atresplayer dentro de la página y escucha): con el plugin activado llegan a TDT local los mensajes del puente
(`ready`, `state`), desde un marco de otro origen y sin instalar ninguna extensión; con el plugin desactivado no llega
ninguno. Al cerrar la ventana se cierra también el servidor Python y no queda ningún proceso. Las pruebas del cargador
(`tests/js/desktop-plugins.test.mjs`) no necesitan Electron.

**Registro:** `desktop/lib/logbook.js` guarda las últimas 2000 líneas en memoria y en `<datos de la app>/logs/` (rotado a 1 MB). Recoge el arranque, los plugins, la ventana de exploración, la salida del servidor Python, los mensajes de la consola de la página (los de los reproductores de dentro, solo avisos, errores y las líneas del puente) y los fallos de red una vez por dirección y sin parámetros. **Ajustes ▸ Registro** lo muestra con filtro y permite copiarlo, guardarlo o abrir su carpeta; `window.tdtDesktop.logs` lo expone solo a la página de TDT local, y el proceso principal lo comprueba en cada llamada.

### Dónde guarda las cosas

- **El servidor y la app comparten una carpeta de datos**: `TDT_DATA_DIR` si existe; la del usuario cuando esté
  instalada (la misma que usa la app instalada de hoy: `%LOCALAPPDATA%\TDT local`, `~/Library/Application Support/TDT
  local` o `~/.local/share/tdt-local`); `data/` junto al código en desarrollo. Lo de Electrón (el almacenamiento de la
  página, el estado de los plugins, el registro) va en su subcarpeta `desktop/`, de modo que se va con ella.
- **El puerto es siempre el mismo.** La página guarda favoritos, último canal y volumen **por origen, y el origen
  incluye el puerto**; con un puerto nuevo en cada arranque (así era el primer prototipo) se perdía todo al cerrar. Ahora
  la app recuerda el último puerto (`desktop/port.json`), lo pide primero, luego prueba del 8790 al 8799 y solo si todos
  están ocupados pide uno cualquiera (y lo anota en el Registro, porque ese arranque empieza sin lo guardado).
- Antes de la 1.3 la app usaba `%APPDATA%\tdt-local-desktop`: al arrancar copia de allí el estado de los plugins si
  aún no existe el nuevo. Lo demás (por ejemplo la respuesta al aviso de cookies de Atresplayer) no se copia.

### El servidor congelado

La app instalada no usará el Python del sistema: llevará el servidor congelado con PyInstaller en `resources/server/`.
Se construye aparte con `python packaging/build.py --server-only` (hace falta `pip install pyinstaller certifi`) y deja
`dist/tdt-local-server/`; es el mismo programa que `python -m tdtlocal`, sin abrir el navegador. Tiene consola para que
la app lea lo que escribe (el Registro) y la app lo arranca oculto, así que no sale ninguna ventana. Para probar este
camino sin instalar nada, `TDT_SERVER_EXE=<ruta al tdt-local-server.exe> npm start` hace que la app de desarrollo use ese
ejecutable en lugar de `python -m tdtlocal`.

### Empaquetar la app

```bash
python packaging/build.py --server-only   # dist/tdt-local-server/
cd desktop
npm install
npm run pack                              # dist/electron/TDT local-<sistema>-<arquitectura>/
```

`desktop/build.mjs` usa `@electron/packager` y mete en la app: el código de `desktop/` dentro de `app.asar`, y al lado, en
`resources/`, el servidor congelado (`server/`), los plugins que vienen con ella (`plugins/`: las carpetas de `tools/` con
`manifest.json`) y el icono de la bandeja y las ventanas (`icon.png`). Quita los idiomas de Chromium que la interfaz no
usa (se queda con español e inglés; unos 50 archivos) y pone el ejecutable como `tdt-local` (`tdt-local.exe` en Windows,
el mismo nombre que ya usa el instalador de hoy). La versión sale de `tdtlocal/__init__.py`; una prueba comprueba que
`desktop/package.json` dice lo mismo, así que al subir de versión hay que cambiar los dos.

Se empaqueta para el sistema en el que se ejecuta (el servidor congelado también es nativo). La app empaquetada no abre el
puerto de depuración de desarrollo (`TDT_DEBUG_PORT`), así que se comprueba desde fuera: que arranca, que su servidor es el
congelado, que un segundo lanzamiento le cede el paso al primero y que al salir no queda ningún proceso. En Windows, sin
comprimir, la carpeta ronda los 335 MB (Chromium es casi todo).

### Plugins de desarrollo

Además de los plugins aislados de arriba hay otro tipo, **sin aislamiento ni permisos**, para quien desarrolla (o para una
IA que edite sus archivos): corren con los mismos poderes que la aplicación, en la página o en el proceso principal.
Funcionan solo con el **modo desarrollador** encendido (Ajustes ▸ Desarrollo, con una pregunta nativa que ninguna página puede
responder; o `TDT_DEV=1`), solo desde su carpeta propia (`<datos>/dev-plugins/`), cada uno activado a mano y con un aviso rojo
permanente en la ventana. Cómo escribirlos, y por qué son así, en [PLUGINS.md](PLUGINS.md).

### Instaladores

`python packaging/build.py` construye con esta app los instaladores de siempre (Inno Setup, `.dmg`, `.deb` y
`.tar.gz`; ver [INSTALLERS.md](INSTALLERS.md)) y `packaging/smoke.py` prueba la app empaquetada; la CI lo hace en
los tres sistemas y, en Linux, también con el `.deb` instalado. Los publicó por primera vez la 1.3.0. A mano solo se
ha visto la carpeta empaquetada y el `.zip` portable en Windows: el `setup.exe`, el `.dmg`, el `.deb` y el `.tar.gz`
los construye la CI.

**Todavía no hay:** migración de los favoritos que tengas en tu navegador (son de otro perfil), actualizaciones
automáticas, firma de código, ni pruebas de audio/vídeo con un canal real dentro de Electrón más allá de la carga del
reproductor.

## Fases propuestas

1. **Modo app** de Chrome/Edge con un ajuste para elegir (ya en la hoja de ruta). Ventana sin barra de direcciones,
   sin dependencias nuevas, extensión del puente como hasta ahora.
2. **Prueba de viabilidad en Electron**: ventana + servidor arrancado/parado + icono de bandeja, sin plugins. Medir peso,
   arranque y que el audio y los canales se comportan como en el navegador.
3. **Cargador de plugins** con el puente como primer plugin y **Ajustes ▸ Plugins** (activar, ver qué toca).
4. **Instaladores** con la app Electron (sustituyen a los actuales) y actualización de la CI.
5. *(Quizás)* plugin de Mediaset, con las condiciones de arriba.

## Preguntas abiertas

- ¿Merece la pena el peso de Electron para el uso que se espera, o basta con la fase 1? *(Decidido: Electron; la fase 1
  sigue siendo el primer paso barato.)*
- ¿Quién usa el servidor sin la app (línea de comandos, `--lan`)? Hay que seguir probándolo y documentándolo.
- ¿Dónde viven los plugins de terceros (carpeta de datos, subidos a mano) y cómo se avisa de actualizaciones?
- Por comprobar: comportamiento de `--load-extension` en las versiones recientes de Chrome (hay indicios de que se ha
  restringido), por si fuera una vía para cargar el puente sin Electron.
