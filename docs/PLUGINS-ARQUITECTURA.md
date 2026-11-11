# Plugins: arquitectura y ejecución (ingeniería)

> **Estado: análisis y propuesta, con mediciones en la aplicación real (Windows, Electron 45). La fase P1 (cimientos) está construida,
> sin publicar ([§11](#11-orden-propuesto)); el resto, no.** Lo que ya existe (plugins con permisos en un marco aislado, de desarrollo, de scripts, el bus de control y
> el MCP) está en [PLUGINS.md](PLUGINS.md) y [HACER-PLUGINS.md](HACER-PLUGINS.md). Este documento responde a otra pregunta: **si queremos
> plugins «de todo tipo» que funcionen bien, ¿qué tipos hay, cómo debe ejecutarse cada uno y qué hay que arreglar del modelo actual?**
> Lo que no se ha comprobado va marcado como **(por comprobar)**.

## 1. Resumen

1. **Hoy hay un solo modelo de ejecución para los plugins nuevos: un marco con su propio proceso.** Aísla muy bien (comprobado) pero
   **cuesta unos 100 MB por plugin** (medido), se **frena a un tick por segundo cuando está oculto o la ventana está minimizada**
   (medido), y **no avisa de nada si cae o se cuelga** (medido). Sirve para paneles; no sirve como único modelo.
2. **Hacen falta cuatro modelos de ejecución, del más barato al más caro:** *declarativo* (sin código ni proceso), *servicio* (un Worker
   en un proceso compartido), *marco* (el actual, para interfaz) y *nativo* (solo desarrollo). Cada tipo de plugin usa el más barato que
   le sirva.
3. **Los plugins deberían declarar lo que aportan (contribuciones) y no solo lo que piden (permisos)**, y la aplicación debería activarlos
   **cuando hacen falta** (al abrir, al llegar un evento, a una hora) y no todos al arrancar.
4. **Antes de añadir tipos nuevos hay que arreglar los cimientos:** una especificación única de la API (hoy los nombres están repetidos
   en cinco sitios y ya nos costó un fallo por ello), límites de ritmo y de memoria, detección de caídas, un almacenamiento que no
   reescriba el disco en cada llamada y códigos de error que un plugin pueda distinguir.
5. **Muchas de las «integraciones» que se piden no deben ser plugins**, sino clientes externos del bus de control con su propio token.

## 2. Qué tipos de plugin hay que soportar

Salen de lo que ya se ha pedido (PRs 3 a 6, hoja de ruta, conversaciones) y de lo que pide cualquier visor de TV:

| # | Tipo | Ejemplos | Qué necesita | Riesgo |
|---|---|---|---|---|
| A1 | **Tema** | colores, fuentes, densidad | variables CSS validadas | nulo |
| A2 | **Efectos de imagen** | Matrix, ASCII, Canal+, VHS, CRT (PR 4) | fragmentos GLSL + metadatos; los ejecuta el núcleo | bajo (un shader puede colgar la GPU) |
| A3 | **Paquete de canales / de guía** | listas extra, XMLTV de otra fuente | direcciones https que el usuario aprueba; los datos los valida el núcleo | bajo |
| A4 | **Reglas** (automatización sin código) | «al empezar el partido, pon La 1», «silencia en los anuncios» | disparadores y acciones de una lista cerrada | nulo |
| A5 | **Atajos y órdenes** | teclas, órdenes de voz, rápidas | tabla declarativa | nulo |
| B | **Pantalla o panel** (interfaz) | teletexto, el tiempo, marcador, guía propia | un marco con interfaz | medio |
| C | **Servicio** (sin interfaz) | avisos «empieza tu programa», sincronizar, vigilar una palabra | lógica en segundo plano, temporizadores, red, notificaciones | medio |
| D | **Fuente de reproducción** | YouTube, Twitch, Atresplayer incrustado | un marco en una casilla, con servidor externo declarado y control de audio | alto |
| E | **Proveedor de datos con código** | U7D de Atresplayer, otras guías | servicio que **entrega** canales y programas al núcleo (validados) | medio |
| F | **Scripts en páginas ajenas** | puente de Atresplayer (ya existe) | inyectar en un sitio declarado | medio |
| G | **Integración con el exterior** | mpv, Omarchy (PR 5), Home Assistant, MQTT, webhook | procesos, red local, sockets | **alto** |
| H | **Herramientas para IAs** | que un plugin aporte órdenes al MCP | contribuir herramientas | alto (inyección de instrucciones) |
| I | **Desarrollo** (ya existe) | cualquier cosa | acceso total | total, a propósito |

Dos conclusiones directas:

- **A1 a A5 (declarativos) son la mitad de los tipos y no necesitan ejecutar ni una línea de código ajeno.** Son los más seguros, los
  más baratos y los que más fácilmente comparte la gente. Hoy no existen y deberían ser el camino por defecto.
- **G no debería ser un plugin.** Un programa que habla con mpv o con Home Assistant ya puede ser un **cliente del bus de control**
  (es lo que hace `tdtv`): corre fuera, con su propio token y nivel, y no tiene que vivir dentro de la aplicación. Lo que falta es un
  bus mejor (ver §7), no un tipo de plugin que ejecute procesos.

## 3. Lo que hemos medido del modelo actual

Plugins con permisos en la aplicación real (Windows 11, Electron 45, Chromium 156). Cada plugin es un `<iframe sandbox>` servido desde
`tdt-plugin://<id>/`. Guiones y resultados en cada fila; cifras de una máquina, no promesas.

| Pregunta | Resultado | Qué significa |
|---|---|---|
| ¿Un plugin que se cuelga con un bucle infinito (8 s) congela la interfaz? | **No**: la página sigue respondiendo en 1 ms | Cada plugin va en **su propio proceso**: el aislamiento de CPU funciona |
| ¿Y si un plugin retiene 700 MB? | La página sigue respondiendo; **la memoria total sube 700 MB**; el plugin no cae | Aísla, pero **no hay tope de memoria**: un plugin puede comerse el equipo |
| ¿Y si un plugin manda 20 000 mensajes de golpe? | La página tarda como mucho 168 ms en responder una vez; sin colapso | Aguanta, pero **no hay límite de ritmo** (cada mensaje cuesta una foto del estado) |
| ¿Cuánto cuesta cada plugin en memoria? | Instancia sin plugins ≈ 575 MB; con 1: +105 MB; con 5: +515 MB; con 15: **+1530 MB (≈ 102 MB por plugin)** | **Un proceso por plugin no escala**: 15 plugins pequeños son 1,5 GB |
| ¿Cuánto tarda en arrancar? | 1 plugin: 279 ms; 5: 327 ms; 15: 425 ms | El arranque no es el problema; la memoria sí |
| ¿Corre el temporizador de un plugin que no se ve? | Panel visible: 50 ticks en 5 s (esperados 50). **Pantalla cerrada (oculta): 5 ticks. Ventana minimizada: 5 ticks** (un tick por segundo) | Un marco oculto se **estrangula a 1 Hz**: nada que dependa de temporizadores rápidos puede vivir en un marco que no se ve |
| ¿Y con la ventana tapada por otras (no minimizada)? | En una pasada el panel visible hizo 31 de 50 y, tras restaurar la ventana, 10 en 9 s | La detección de «ventana tapada» de Chromium también frena: **(por comprobar)** con una medición limpia |
| Latencia de `tdt.player.state()` | 0,26 ms por llamada | El camino por la página es barato |
| Latencia de `tdt.storage.set()` / `get()` | **3,4 ms** / 0,47 ms por llamada | `set` reescribe el archivo entero en cada llamada: un plugin que guarda a menudo castiga el disco; `get` lo lee y lo analiza entero cada vez |
| ¿Qué pasa si un plugin cae (proceso muerto)? | Ni la página ni los demás plugins se enteran; **el registro no dice nada**; el panel queda en blanco hasta que el usuario pulsa ⟳ | **Nadie vigila**: ni el usuario ni la aplicación saben que algo falló |
| ¿Un plugin hostil escapa de la caja? | No (prueba con 18 intentos: red, `parent`, `localStorage`, cookies, ventanas, navegación…) | La caja funciona; WebRTC y las precargas de DNS siguen siendo huecos conocidos |

Lo que **no** se ha medido todavía y habría que medir antes de fijar números: consumo de CPU sostenido por plugin (la aplicación podría
leerlo con `app.getAppMetrics()` asociando cada marco a su proceso por `WebFrameMain.osProcessId`, **por comprobar**), el coste real de un
Worker frente a un marco, si un Worker en una ventana oculta con `backgroundThrottling: false` mantiene el ritmo, y macOS y Linux.

## 4. Los modelos de ejecución

Regla de diseño: **cada plugin usa el modelo más barato que le sirva.**

| Modelo | Dónde corre | Código ajeno | Coste | Sirve para | Límites |
|---|---|---|---|---|---|
| **R0 Declarativo** | el núcleo lo interpreta | ninguno | casi nulo | A1 a A5 | solo lo que el núcleo sabe hacer con esos datos |
| **R1 Servicio** | un **Worker** dentro de una ventana oculta compartida (un proceso para todos los servicios, un Worker por plugin) | sí, sin DOM | **pequeño** (estimación 5 a 10 MB por Worker, **por comprobar**) | C, E, parte de D | sin DOM ni canvas de ventana (sí `OffscreenCanvas`), sin red propia: todo por `tdt.*` |
| **R2 Marco** | un `<iframe sandbox>` con su propio proceso (como hoy) | sí, con DOM | **≈ 100 MB cada uno** | B, D | se estrangula si está oculto |
| **R3 Nativo** | el proceso principal | sí, sin aislamiento | total | I (desarrollo) | solo con modo desarrollador |

### 4.1 R1 Servicio, el que falta

La ventana oculta de servicios se crea con `show: false` y `webPreferences.backgroundThrottling: false`, sin `nodeIntegration`, con
`sandbox: true` y una política de contenido propia. Cada servicio es un `Worker` cuyo script sirve el protocolo `tdt-plugin://` con
`connect-src 'none'`, de modo que **no puede hacer peticiones**: todo pasa por un canal de mensajes con el mismo SDK que un marco, menos
lo que necesita DOM. Ventajas: poco gasto por plugin, temporizadores que no se frenan (esto **hay que comprobarlo**: un Worker no se
estrangula igual que un marco oculto, pero no lo hemos medido) y un único sitio donde vigilar. Desventaja: **un fallo de memoria en un
Worker tira todo el proceso de servicios**. Mitigación: repartir en grupos pequeños (por ejemplo 5 por proceso), reiniciar el grupo y
**desactivar al culpable tras dos caídas seguidas** con un aviso.

### 4.2 R2 Marco, lo que hay que cambiar

- **Montaje perezoso y descarga.** Una pantalla que no está abierta **no debería existir**: hoy cada plugin de pantalla gasta 100 MB y
  corre a 1 Hz aunque nadie lo vea. Se monta al abrir y se destruye al cerrar; el estado se guarda en `tdt.storage`.
- **Máximo de paneles flotantes a la vez** y un aviso si se pasa.
- **Latido y vigilancia:** la aplicación pregunta a cada marco montado cada 5 s; con tres silencios lo marca «no responde» con
  **Recargar** y **Desactivar**. Es la única forma uniforme de detectar caídas y cuelgues (`render-process-gone` solo avisa de las
  ventanas principales, **por comprobar** para marcos).
- **Presupuestos:** un tope de memoria por marco (propuesta: 200 MB) y de CPU sostenida; al pasarse, aviso y descarga.

### 4.3 Dos reglas que salen de la medición

- **No promesas de tiempo real en un marco.** Si un plugin necesita reaccionar a algo, que se **suscriba a un evento** (`tdt.on(...)`)
  y no mire el reloj; para algo periódico, que sea un **servicio**.
- **Todo plugin con interfaz debe poder reconstruirse desde `storage`**, porque la aplicación lo descargará cuando no se vea.

## 5. Estructura: contribuciones, activación y manifest

Hoy un manifest dice «tengo una página y un panel». Para tipos de todo tipo hace falta que diga **qué aporta**:

```json
{
  "name": "Teletexto", "version": "1.2.0", "author": "…",
  "tdt": {
    "api": 1,
    "requires": { "api": "1.2" },
    "contributes": {
      "screen":   { "entry": "index.html", "label": "Teletexto" },
      "settings": { "ciudad": { "type": "choice", "options": ["Madrid", "Sevilla"], "default": "Madrid", "label": "Ciudad del tiempo" } }
    },
    "activation": ["onOpen"],
    "permissions": ["storage", "network:api.open-meteo.com"],
    "optionalPermissions": ["epg.read"]
  }
}
```

Puntos de contribución (cada uno con su esquema y su modelo de ejecución):

| Contribución | Modelo | Qué ve el usuario |
|---|---|---|
| `theme` | R0 | un tema más en Ajustes |
| `effects` | R0 | efectos en el menú de la casilla |
| `channels`, `epg` | R0 | listas y guías extra |
| `rules` | R0 | reglas en Ajustes ▸ Automatizaciones |
| `keymap`, `commands` | R0 | atajos y órdenes |
| `screen`, `panel` | R2 | botón en la barra de controles / panel flotante |
| `service` | R1 | nada (o una entrada en Ajustes) |
| `source` | R2 en una casilla | un servicio de reproducción más |
| `provider` | R1 | canales y programas que entrega al núcleo |
| `settings` | R0 | **una página de ajustes generada** a partir del esquema, sin que el plugin dibuje nada |

**Ajustes generados.** Hoy un plugin que quiere un campo («tu ciudad») tiene que construir su propia interfaz. Si declara el esquema, la
aplicación pinta el formulario, valida y guarda, y el plugin lee `tdt.config.get('ciudad')`. Es la mayor mejora de experiencia para quien
hace plugins y para quien los usa.

**Activación por eventos** (como las de VS Code): un plugin dice cuándo hace falta (`onStartup`, `onOpen`, `onEvent:player.change`,
`onSchedule:*/5m`, `onUrl:…`) y **no corre hasta entonces**. Con esto, los 15 plugins del ejemplo de memoria dejan de pesar 1,5 GB porque
casi ninguno está activo a la vez.

**Versiones.** `tdt.api` pasa a ser `mayor.menor`: las versiones menores solo **añaden**; un plugin declara la que necesita
(`requires`) y puede preguntar `tdt.supports('epg.list')`. Cualquier cosa que se quite pasa antes por una versión con aviso de obsoleta.
Los manifests de hoy (`api: 1`, `panel`, `entry`) siguen valiendo: se leen como `contributes.panel`.

## 6. Permisos

Lo que hay hoy (lista cerrada, se aprueba todo junto, preguntando de nuevo si cambia) es un buen punto de partida. Faltan:

1. **Permisos individuales.** El usuario debe poder activar el plugin **sin** `network:…` si no quiere, y el plugin tiene que sobrevivir
   a la negativa. Hoy es todo o nada.
2. **Permisos opcionales pedidos al usar** (`tdt.permissions.request([...])`, solo tras un gesto del usuario), con ventana nativa. Un
   plugin que solo a veces necesita la guía no debería pedirla al instalarse.
3. **Niveles de riesgo en la pregunta.** Bajo (`ui.toast`, `storage`), medio (`player.read`, `epg.read`, `channels.read`), alto
   (`player.control`, `network:…`, notificaciones, ocupar la pantalla) y crítico (`embed:…`, `source`). Se enseñan distinto.
4. **Qué ha hecho el plugin**, visible: número de llamadas, bytes por la red, últimos servidores, errores. Es la forma de que «hablar con
   internet» sea comprobable y no solo declarado.
5. **Permisos nuevos que habrá que definir:** `embed:servidor` (marcos de un servidor concreto), `notify` (notificaciones del sistema),
   `source` (ser una fuente de canal), `provide:channels` / `provide:epg`, `schedule` (activación por hora), `keys` (teclas globales),
   `video.read` (leer píxeles del vídeo, solo para efectos que no sean declarativos). Cada uno con su texto en lenguaje llano.
6. **Revocación y modo seguro.** Un botón para apagar todos los plugins y arrancar sin ellos; entrada automática en modo seguro si un
   plugin tira la aplicación dos veces seguidas.

## 7. El protocolo entre plugin y aplicación

Lo que hay (`postMessage` con `{id, method, args}`) funciona pero es pobre. Propuesta:

- **Sobre versionado:** `{v: 1, id, kind: 'req' | 'res' | 'event' | 'cancel', method, args}`.
- **Errores con código:** `E_PERMISSION`, `E_RATE`, `E_TIMEOUT`, `E_INVALID`, `E_UNAVAILABLE`, `E_QUOTA`; hoy un plugin solo recibe un
  texto y tiene que analizarlo.
- **Suscripciones explícitas** (`subscribe` / `unsubscribe`) con **coalescencia** (si hay varios cambios, se envía el último), y no
  difusión a todos.
- **Límite de ritmo** por plugin (cubo de fichas: ráfaga de 200, 100 por segundo, ajustable por permiso), límite de tamaño por mensaje y
  cancelación (`AbortSignal`).
- **Almacenamiento con caché en memoria y escritura diferida** (medio segundo): medido, `set` cuesta 3,4 ms porque reescribe el archivo
  entero; con diferida cuesta microsegundos y no castiga el disco.
- **Una especificación única de la API** (`api.json`: método, permiso, argumentos, resultado, desde qué versión) de la que se **generan o
  validan** el SDK, la tabla de permisos del anfitrión, la guía para autores y la guía del MCP. Hoy esos cinco sitios se escriben a mano y
  **ya nos fallaron por eso** (el anfitrión leía `cat` y la página escribe `category`: la categoría salía siempre vacía y el teletexto
  se quedó sin la página de televisión).

### El bus de control, para el mundo exterior

Las integraciones del tipo G se hacen **desde fuera**, así que el bus necesita crecer: **tokens con nombre** (uno por cliente, cada uno
con su nivel y revocable), **un flujo de eventos** (hoy solo se puede preguntar por el estado) y **órdenes con respuesta tipada**. `tdtv`
del PR 5 ya funciona así; con esto sería una pieza más de un conjunto, no un caso especial.

## 8. Seguridad: modelo de amenazas

| Amenaza | Defensa hoy | Qué falta |
|---|---|---|
| Plugin malicioso que roba datos | caja sin red; red solo a servidores declarados y por https a direcciones públicas; el usuario ve la lista | WebRTC y precargas de DNS; registro de actividad visible |
| Plugin que agota recursos | un proceso por plugin (la interfaz sigue viva) | tope de memoria y CPU; límite de ritmo; vigilancia |
| Plugin que se hace pasar por la interfaz | cabecera de la aplicación en los paneles de pantalla | marca visible también en los flotantes; sin teclas globales sin permiso |
| Datos hostiles (un RSS con HTML o instrucciones) | el ejemplo escribe con `textContent` | el SDK debería dar utilidades que escapen por defecto |
| Actualización comprometida | el hash del archivo se enseña al instalar | **pin de huella y firma de autor**, y que una actualización con permisos nuevos pregunte antes de correr (ya ocurre) |
| IA que escribe plugins por el MCP | ventanas nativas con el código a la vista (plugins de desarrollo) | lo mismo para plugins con permisos |
| Un plugin que aporta herramientas al MCP | no existe | **no** en la primera versión: multiplica la inyección de instrucciones |

## 9. Cómo se publica y se comparte

Hoy: `.tdtplugin` (zip reproducible) con su SHA-256, instalar desde archivo. Siguiente paso razonable, sin montar una tienda:

1. **Catálogo como repositorio:** un `index.json` en GitHub con cada plugin (nombre, autor, versiones, SHA-256, permisos, enlace). Entrar en
   él es un pull request revisado a mano. La aplicación lo lee si el usuario lo activa y **enseña lo mismo que al instalar un archivo**.
2. **Instalar desde un enlace** (https, con el hash fijado en el catálogo): descarga, comprueba, enseña, pregunta.
3. **Firma de autor** (ed25519, clave pública en el catálogo, primera vez «confiar en esta clave» y desde entonces se avisa si cambia).
4. **Actualizar:** manual y con diferencias a la vista (permisos nuevos, tamaño, hash).

## 10. Cómo sabremos que funciona

Lo medido hoy sale de unos guiones sueltos. Para que sea una garantía y no una foto:

- **Un banco de pruebas de plugins en el repositorio**: los plugins hostiles (bucle, memoria, inundación, caída, sonda de aislamiento) y el
  guion que los lanza en la aplicación real, con **umbrales que fallan** (por ejemplo «la página responde en menos de 50 ms mientras un
  plugin gasta CPU»).
- **Pruebas de contrato** generadas de `api.json`: cada método, con y sin permiso, con argumentos válidos y no.
- **Medición de recursos por plugin** como función de la aplicación (memoria, CPU, mensajes), y el mismo dato en el banco de pruebas.
- **Pruebas en macOS y Linux** del aislamiento y de la caída de un marco.

## 11. Orden propuesto

Cada fase se puede publicar sola y no depende de las siguientes.

| Fase | Qué | Cómo se sabe que está |
|---|---|---|
| **P1 Cimientos** (**hecha, sin publicar**: `plugin-api.json`, códigos de error, límite de ritmo, almacenamiento con caché, latido y caída, pantallas que se destruyen al cerrar, permisos individuales, actividad por plugin, todo consultable por el MCP y `scripts/plugin-lab/bench.mjs` con 36 comprobaciones; ver [§11b](#11b-lo-que-ha-medido-la-p1)) | `api.json` único; códigos de error; límite de ritmo; almacenamiento con caché; latido y detección de caída con aviso; montaje perezoso y descarga de pantallas; registro de actividad por plugin; permisos individuales | El banco de pruebas pasa con umbrales; un plugin que cae o se cuelga **se ve** y se recarga o desactiva con un clic; una pantalla cerrada no gasta memoria |
| **P2 Declarativos** (**empezada, sin publicar**: las **reglas** están hechas, con MCP y confirmación; ver [§14](#14-hackeable-la-escalera). Faltan tema, paquetes de canales y de guía, atajos y ajustes generados) | tema, reglas, paquetes de canales y de guía, atajos, ajustes generados | Una regla («al empezar X, pon Y») funciona sin código; un plugin con ajustes tiene formulario sin dibujar nada |
| **P3 Servicios** (**empezada, sin publicar**: activación por eventos y por hora, y servicios que duermen; ver [§14](#14-hackeable-la-escalera). Faltan los Workers y las notificaciones) | ventana de servicios con Workers; activación por eventos y por hora; notificaciones | Un servicio avisa de un programa a su hora con la ventana minimizada; 15 servicios caben en una fracción de lo que costarían 15 marcos |
| **P4 Fuentes y proveedores** | permiso `embed`; `source`; YouTube, Twitch y el reproductor de Atresplayer como plugins; U7D como proveedor | Twitch reproduce en una casilla con silencio y volumen en multivisión, sin script de terceros en la página del núcleo |
| **P5 Efectos** | canalización de efectos GLSL declarativos (los del PR 4) | Doce efectos como plugins con el mismo resultado visual |
| **P6 Publicación** | catálogo, instalar por enlace, firmas, actualizar con diferencias | Instalar un plugin desde el catálogo enseña y verifica lo mismo que un archivo |
| **P7 Bus** | tokens con nombre, flujo de eventos | `tdtv` y un cliente de prueba conviven con niveles distintos |

**Por qué P1 va primero:** todo lo demás se apoya en ella (un servicio sin latido, o una fuente sin presupuestos, hereda los mismos fallos), es
lo que hace que los plugins «funcionen bien» antes de que haya más tipos, y es donde está lo que ya medimos que falla.

### 11b. Lo que ha medido la P1

Las mismas pruebas de la §3, repetidas con la P1 puesta, en el banco `scripts/plugin-lab/bench.mjs` (36 comprobaciones, todas bien):

| Pregunta | Antes | Con la P1 |
|---|---|---|
| Una ráfaga de 3000 llamadas de un plugin | sin límite; la página tardó hasta 168 ms con 20 000 | **203 pasan y 2797 fallan con `E_RATE`**; la página responde en 2 ms |
| Un plugin que gasta CPU 6 s | la página respondía en 1 ms | igual (1 ms): sigue aislado |
| `tdt.storage.set` | 3,4 ms (reescribía el archivo) | **0,39 ms** (caché y escritura diferida) |
| Un plugin que se cuelga (26 s) | nadie se enteraba | **se marca «no responde» a los ≈ 20 s**, el Registro lo cuenta y **vuelve a «en marcha»** unos 7 s después de contestar |
| Un plugin cuyo proceso cae | silencio hasta que el usuario pulsaba ⟳ | **se marca «no responde»** y recargar lo trae de vuelta |
| Una pantalla cerrada | seguía viva (≈ 100 MB, 1 Hz) | **no tiene marco**: se crea al abrirla y se destruye al cerrarla |
| Errores | un texto | un `code` (`E_PERMISSION`, `E_INVALID`, `E_QUOTA`, `E_UNSUPPORTED`…) además del texto |
| Un permiso sin el que el usuario quiere que siga | todo o nada | se quita **uno** y el plugin se reinicia sin él (`E_PERMISSION`: «el usuario lo ha desactivado») |
| Lo que se podía consultar por el MCP | solo plugins de desarrollo | **todo**: estado, actividad, Registro, API, activar, apagar, quitar y devolver permisos |

Dos matices que salieron al construirlo: una página que no carga el SDK **no puede contestar al latido** (se muestra «en marcha» y no se
vigila, y la guía lo dice); y el banco desactiva el frenado de ventanas ocultas de Chromium (`disable-backgrounding-occluded-windows` y
otras, solo con `TDT_DEBUG_PORT` y sin instalar), porque sin eso las mediciones dependían de lo que hubiera delante de la ventana.

**Y, encima de P1, la IA ya puede programar un plugin ella misma** (`tdt_plugin_read` y `tdt_plugin_write`): comprobación previa con avisos, una
ventana nativa con los permisos y el código, nada se activa al escribir, recarga en vivo; el banco lo prueba entero en la aplicación real
(55 comprobaciones).

**Lo que P1 no incluye todavía:** el tope de memoria y de CPU por marco (no se ha comprobado `WebFrameMain.osProcessId` ni
`app.getAppMetrics()`), el límite de paneles flotantes a la vez, la activación por eventos (P3), y que el banco corra en CI.

## 12. Decisiones que hay que tomar (con lo que recomiendo)

1. **¿Un proceso por plugin de interfaz o compartido?** Recomiendo **mantener un proceso por marco** (el aislamiento medido es bueno) y **no
   usar marcos para lo que no tiene interfaz**: eso va a Workers.
2. **¿Declarativo primero?** Sí: es el camino por defecto para quien comparte algo sencillo.
3. **¿Ajustes generados desde el esquema?** Sí, es lo que más mejora la experiencia de autor y de usuario.
4. **¿La aplicación sigue viva sin ventana (en la bandeja)?** Hoy cerrar la ventana la cierra. Para servicios que avisan, habría que permitir
   residente en la bandeja con un ajuste. Recomiendo **sí, desactivado por defecto**.
5. **Confianza en plugins sin firmar.** Recomiendo permitirlos con el aviso actual y reservar un sello visible a los que lleven firma de
   autor conocida.
6. **¿Pueden hablar entre sí los plugins?** Recomiendo **no** en la primera versión; si hace falta, un bus de eventos con espacio de
   nombres y permiso, nunca llamadas directas.
7. **Promesa de estabilidad.** Recomiendo declarar la API 1.x como **estable en lo que ya existe** (nada se quita sin una versión de
   aviso) y marcar lo nuevo como experimental hasta que lo use alguien más que nosotros.
8. **Herramientas para IAs aportadas por plugins** (tipo H): **no todavía.**

## 13. Lo que hay que averiguar antes de construir

- ~~Si `WebFrameMain.osProcessId` y `app.getAppMetrics()` permiten atribuir memoria y CPU a cada plugin con precisión~~: **sí** (comprobado en la aplicación real). Ojo: Electron da la CPU como parte de **todos** los núcleos (un bucle en un núcleo de 32 sale como 3 %), y hay que multiplicar.
- El coste real de un Worker en una ventana oculta y si mantiene el ritmo con `backgroundThrottling: false` (**por comprobar**).
- Si `WebFrameMain.osProcessId` y `app.getAppMetrics()` permiten atribuir memoria y CPU a cada plugin con precisión (**por comprobar**).
- Si una caída de un marco se puede detectar sin latido en alguna versión de Electron (**por comprobar**); el latido vale siempre.
- Si Twitch acepta su reproductor dentro de un marco sin origen propio (**por comprobar**; decide la forma de P4).
- El comportamiento en macOS y Linux, sobre todo del frenado de marcos ocultos y de la detección de ventana tapada.
- Cuántos plugins de interfaz abiertos a la vez son razonables para el usuario: dato de uso, no de ingeniería.

## 14. Hackeable: la escalera

El objetivo, dicho en una frase: **que cualquiera pueda hacer con la aplicación lo que quiera, de forma sencilla, sin que eso le cueste la
seguridad.** No es una función más: es una forma de construir todo lo demás. Cuatro ideas:

1. **Todo lo que la aplicación hace es una orden con nombre**, con su permiso y su documentación, y se puede lanzar igual desde un botón, un
   atajo, una regla, un plugin o una IA por MCP. Una función nueva nace ya así, y no hay que «abrirla» después.
2. **Todo lo que pasa es un evento** (cambió el canal, empezó un programa, llegó una marca de anuncio, un canal dejó de responder) al que se
   puede suscribir una regla o un plugin. Con órdenes y eventos se construye casi cualquier automatización.
3. **Una escalera de dificultad**, y que cada peldaño sirva para el siguiente: *ajustes* (interruptores) ▸ *reglas* (datos, sin código) ▸
   *plugins con permisos* (código aislado) ▸ *plugins de desarrollo* (sin aislamiento). La **IA es la rampa**: describes lo que quieres y
   te lo escribe, y tú lo ves y lo apruebas.
4. **Atreverse tiene que ser barato**: permisos que entiendes, todo reversible (quitar, deshacer, modo seguro), el código a la vista antes de
   aceptar, compartir con un enlace.

### Estado

| Pieza | Estado |
|---|---|
| Plugins con permisos aislados, SDK, permisos individuales, vigilancia, actividad | **Hecho** (P1) |
| Una IA escribe plugins (con permisos y de desarrollo) por MCP, con confirmación nativa | **Hecho** |
| Cabeceras de canal editables, también por MCP | **Hecho** |
| **Reglas** «cuando pase esto, haz aquello» (hora, canal, programa ▸ poner canal, volumen, silencio, multivisión, aviso), con editor, MCP y confirmación | **Hecho**, sin publicar ([REGLAS.md](REGLAS.md)) |
| Lista única de órdenes y eventos (`static/commands.json`) a la que se **ajustan** reglas, bus de control, plugins y MCP | **Hecho**, sin publicar: cada tabla sigue en su sitio, pero las pruebas comprueban que todas entienden exactamente lo mismo (ejemplos y límites). Falta que los botones de la interfaz salgan también de ella |
| Bus de eventos (`tdt.on`) más allá de `player` | **Hecho** para `channel.changed`, `kind.changed`, `volume.changed` y `programme.started`, con `cause` y por MCP (`tdt_events`). Faltan `ad.marker` (marcas de anuncio) y `channel.status` (un canal deja de responder) |
| Ajustes generados desde el manifest (`tdt.settings` ▸ `tdt.config`) | **Hecho**, sin publicar: formulario en Ajustes ▸ Plugins, lectura sin permisos, evento `config.changed` y `tdt_plugin_config` por MCP con confirmación. Faltan ajustes con dependencias entre sí y secciones |
| Reglas y atajos de teclado aportados por un plugin (`tdt.rules`, disparador `key`) | **Hecho**, sin publicar: apagadas hasta que el usuario las enciende. Los **temas** (`tdt.themes`, solo colores, los elige el usuario) también están hechos |
| Servicios sin interfaz y activación por eventos y por hora | **Hecho**, sin publicar (`tdt.activation`: `onEvent:`, `onTime:`, `onStartup`; duermen sin proceso y vuelven a dormir tras un minuto ocioso). Falta la **ventana de servicios con Workers** (muchos servicios en un solo proceso, que es lo que haría caber 15 servicios en una fracción de la memoria), las notificaciones del sistema y el modo residente en la bandeja |
| Puntos de enganche en la interfaz: botones de la barra, menú de la casilla, superposición, paneles | Parcial: paneles y pantalla; faltan botones, menús y superposición |
| Fuentes de reproducción y proveedores de listas como plugins | **Parcial**, sin publicar: fuentes declarativas (`tdt.sources` + `embed:servidor`, política de marcos acotada a lo aprobado) con Twitch como ejemplo, **comprobado con un directo real** (carga y arranca con un clic; no solo). **YouTube y Atresplayer siguen en el núcleo a propósito** (ver el análisis de abajo) |
| Proveedores de canales como plugins (`tdt.channels.provide` + `provide:channels`) | **Hecho**, sin publicar, probado en la aplicación real. **Hecho también el proveedor de guía** (`tdt.epg.provide` + `provide:epg`, bajo `plugin:canal`, en memoria). Falta limpiar un proveedor que desapareció con la aplicación cerrada (el código está, sin prueba) |
| Inspector en vivo (qué eventos y llamadas pasan) | **Hecho**, sin publicar (diálogo y `tdt_plugin_calls`). Faltan «ver el código de esto» y una consola de plugins |
| Catálogo e instalar por enlace (https público, hash fijado, la misma pregunta que un archivo) | **Hecho**, sin publicar. **Firmas de autor** (ed25519, `scripts/plugin-sign.mjs`, confianza en el primer uso y aviso si la clave cambia o desaparece) también hechas. Falta actualizar con diferencias a la vista (permisos nuevos, tamaño) y un directorio de claves de confianza |
| Límites de memoria y CPU por plugin | **Hecho**, sin publicar: se atribuye cada proceso a su plugin (`osProcessId` + `getAppMetrics`, comprobado), 300 MB y 80 % de un núcleo durante 20 s, se para el marco y se puede recargar. Límites de la medición: es por proceso, y un reinicio en un proceso que retiene su memoria solo se vigila por crecimiento |
| Modo seguro (arrancar sin plugins; entra solo tras dos cierres malos seguidos, o con `--safe`, `TDT_SAFE_MODE=1` o el botón) | **Hecho**, sin publicar, probado en la aplicación real (`scripts/plugin-lab/safe-mode.mjs`, 15 comprobaciones con arranques y cierres reales). No detecta un plugin que rompe solo la página (sin que la aplicación se cierre) |
| Tokens con nombre y flujo de eventos para clientes de fuera (P7) | Falta |

### Por qué YouTube y Atresplayer no se han movido a plugins

Se comprobó en el código antes de tocar nada. Moverlos ahora **rompería cosas que funcionan**:

1. **El sonido en multivisión.** El núcleo silencia y baja el volumen de YouTube con órdenes por `postMessage` (`ytCmd`, `enablejsapi=1`) y el de Atresplayer
   (y sus efectos) con el protocolo del puente (`atresAudio`, `atresFx`). Una fuente declarativa (`tdt.sources`) enseña un reproductor pero **no puede
   controlar su sonido**: en multivisión sonarían a la vez. Falta una pieza: **adaptadores de control** (`youtube`, `puente-atresplayer`) que el núcleo
   conoce y que una fuente elige con un campo `control`, sin que el plugin escriba código.
2. **El modo navegador.** `python -m tdtlocal` no tiene plugins (son de la aplicación de escritorio): si YouTube fuera un plugin, **dejaría de funcionar** ahí.
3. **La política de marcos.** `frame-src` del servidor nombra hoy a YouTube y Atresplayer; con plugins se ampliaría solo con lo aprobado, y el servidor
   no puede quitarlos sin romper el modo navegador.
4. **Atresplayer ya está casi todo fuera**: el puente de audio (`tools/puente-atresplayer`) y la lista de U7D (`tools/atresplayer-u7d`) son plugins; en
   el núcleo queda solo el reproductor incrustado y el protocolo de mensajes.

**Camino para moverlos sin perder nada:** (a) los adaptadores de control (punto 1; **hecho**: `control: "youtube"` y `"atres"` en `tdt.sources`, probado con YouTube real); (b) enviarlos como plugins incluidos con la aplicación de escritorio **y
mantener los integrados para el modo navegador**; (c) quitar los integrados solo si el modo navegador también tiene fuentes incluidas, o si se decide dejar de
darle soporte. Hasta entonces moverlos sería una pérdida de funciones sin ganancia.

### Lo que se mantiene fijo

- Cada permiso lo concede el usuario en una **ventana nativa** que ninguna página puede pulsar, y lo que escribe una IA se le enseña **con el
  código o los datos a la vista** antes de aplicarlo.
- La API tiene versión y pruebas de compatibilidad; lo que se quita pasa antes por una versión con aviso.
- Las reglas **no ejecutan código**: solo las órdenes que ya existen, con límites de ritmo y de cantidad.
- No se saltan DRM ni se capturan flujos protegidos.
- Todo lo que se pueda hacer se puede **ver y consultar** por MCP.
