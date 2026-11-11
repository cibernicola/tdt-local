# TDT local, hackeable de base

Este documento es la **visión**: qué queremos que sea TDT local y cómo se llega. Manda sobre lo que se hizo antes en plugins (que se queda, pero cambia de papel). El mapa de dónde decide hoy el núcleo está en
[PUNTOS-DE-ENGANCHE.md](PUNTOS-DE-ENGANCHE.md), que es su anexo.

## 1. Qué queremos

Que **cualquiera pueda hacer un plugin de lo que quiera, en cualquier parte de la aplicación**, como en WordPress. Ejemplos que lo ponen a prueba:

- usar **su propio reproductor**;
- poner **una capa sobre la pantalla** de lo que sea;
- hacer **lo que se le ocurra cuando haya publicidad** (una de las ramas que hay que dejar bien resueltas, porque cada uno tiene mil necesidades distintas);
- cambiar **el aspecto entero**, no solo los colores.

La prueba de que está bien hecho: **si la aplicación lo hace, un plugin puede hacerlo**, porque la aplicación lo hace por el mismo camino.

## 2. Principios

1. **Un solo nivel de plugin, con todo el poder.** Un plugin es código dentro de la aplicación, como en WordPress. No hay permisos finos: el usuario lo instala sabiendo que es como instalar un programa, con un aviso claro. Es lo único
   que permite sustituir un reproductor o contestar un filtro en el acto.
2. **El aislamiento actual pasa a ser el «modo ligero»**: marco aislado, mensajes y permisos. Sigue funcionando igual, para quien quiera un plugin de bajo riesgo. Ya no es la base del sistema.
3. **El núcleo no decide a solas.** Cada decisión pasa por un punto donde otros pueden mirar, cambiar o reemplazar. Lo que la aplicación hace por defecto es **el primer eslabón de la cadena**, no un `if` aparte.
4. **Una API, la misma en los tres sitios** donde corre código: la página, el servidor Python y Electron.
5. **Los cinturones se quedan:** modo seguro, firmas de autor, catálogo, inspector, límites de memoria y procesador. Ahora protegen a plugins con todo el poder. Un plugin que falla se atrapa y se desactiva; no tumba la aplicación.
6. **Nada de reescribirlo todo.** Solo se migra lo que paga la pena (publicidad, reproductores). La lista de canales, la guía o los Ajustes no tienen que ser plugins: les basta un filtro o una ranura.

## 3. Diseño

### Qué es un plugin

Una carpeta con `plugin.json` (identificador, nombre, versión, qué piezas aporta y dónde corre cada una) y código:

| Archivo | Dónde corre |
|---|---|
| `page.js` | la interfaz (módulo ES) |
| `server.py` | el servidor Python, en el mismo proceso |
| `main.js` | Electron, si hace falta |

Un mismo plugin puede tener las tres partes.

### La API

Cada plugin recibe `tdt` al cargarse, con los mismos nombres en los tres sitios:

| Pieza | Para qué | Ejemplo |
|---|---|---|
| **Acción** | mirar que algo ha pasado | `tdt.on('ad.started', fn, prioridad)` |
| **Filtro** | cambiar un valor antes de que el núcleo lo use (síncrono, con prioridad) | `tdt.filter('ad.reaction', fn, prioridad)` |
| **Registro** | añadir una cosa que el núcleo trata como propia | `tdt.register('players' / 'actions' / 'keys' / 'templates', …)` |
| **Ranura** | llenar un sitio de la pantalla | `tdt.slot('tile.overlay', elemento)` |
| **Servicio** | usar o reemplazar una pieza del núcleo | `tdt.services.player`, `.channels`, `.audio`, `.guide` |

Reglas:

- **Prioridad:** varios plugins en el mismo punto se ordenan; el del núcleo va primero salvo que alguien lo reemplace.
- **Reemplazar y volver:** si se desactiva el plugin que reemplazó algo, vuelve lo del núcleo.
- **Aislar fallos:** si el código de un plugin lanza una excepción en un gancho, se registra, se salta ese eslabón y, si repite, se desactiva el plugin.

### El núcleo se engancha a sí mismo

Publicidad, reproductores (HLS, directo, YouTube, Atresplayer, U7D, fuentes de plugin), subtítulos y reglas pasan a ser **plugins incluidos** que carga el mismo cargador que uno de fuera. Cada migración debe dejar el
comportamiento igual y los tests intactos.

### Publicidad como ejemplo

- Acciones: `ad.started`, `ad.ended`, `ad.marker` (con canal, tipo de marca, duración conocida o no, origen).
- Filtro `ad.reaction`: recibe la reacción por defecto (una lista de acciones) y devuelve la que se hará.
- Registro `actions`: «cartel», «bajar audio», «cambiar de canal», «mostrar web» y «avisar» son acciones normales. Un plugin registra las suyas (un webhook, una capa, una alarma) y las pone en la reacción. Cada acción dice
  cómo se deshace al acabar el corte.

### Temas

Un tema es un plugin de tipo `theme`; solo hay uno activo. Puede aportar:

- una **hoja de estilo completa** que se carga después de la del núcleo;
- **variables** (colores, tamaños, tipografías), como los temas de ahora, ampliados;
- **plantillas** que reemplazan una pieza (casilla, fila de canal, cabecera) por el registro `templates`;
- **recursos** propios (tipografías, imágenes, iconos);
- **tema hijo**: «como este, pero cambia esto»;
- **código opcional**, porque también es un plugin.

Hace falta **estabilizar los nombres de las clases CSS y las variables** y documentarlos como contrato. El modo seguro desactiva también el tema.

## 4. Cómo se llega: hitos

Cada hito vale por sí solo; se puede parar donde se quiera.

1. **Bus de ganchos, registros y cargador** (página y Python). **Publicidad** migrada como primer plugin incluido.
2. **Ranuras de interfaz** (`tile.overlay` primero) **y temas completos**, que comparten la base: sacar las piezas de la pantalla a un registro.
3. **Registro de reproductores:** migrar la cadena de `Tile.attempt` sin cambiar el comportamiento. Es el hito delicado.
4. **Filtros de datos** (`channels.list`, `guide.programmes`) **y teclas.**

Criterio de «bien hecho» en cada hito: lo integrado pasa **por el mismo camino** que un plugin; hay un plugin de laboratorio que reemplaza algo integrado y lo demuestra; los límites y el modo seguro valen igual.

## 5. Lo que no sale gratis

- Un plugin puede hacer **lo que quiera con la aplicación y los datos del usuario**. Es la misma elección que WordPress, VS Code u Obsidian. Se compensa con aviso claro, firma del autor, modo seguro y catálogo, no con muros.
- **Mantener todo funcionando mientras se mueve** pesa más que escribir código. Por eso se migra pieza a pieza.
- Los **nombres de clases CSS y de ganchos pasan a ser API:** cambiarlos rompe a terceros.
- No se puede probar en macOS ni en Linux (solo en Windows). Es un límite conocido y no se promete lo contrario.

## 6. Estado

**Hito 1, hecho en parte** (sin publicar):

- Hecho: el bus (acciones con prioridad, filtros, registros) y el cargador, en la página y en el servidor, con sus pruebas; los eventos `ad.started`/`ad.ended` y la acción de servidor
  `ad.marker`; la publicidad migrada a un plugin incluido (`tdtlocal/static/plugins/ads/`), con las mismas pruebas de comportamiento que antes y una prueba de que otro plugin puede
  añadir un paso, quitarlo o reemplazar una acción; comprobado en una página real (el plugin incluido y uno de prueba que pone un cartel).
- Hecho también, **sin construir otro nivel**: los **plugins de desarrollo** que ya existían (sin aislamiento, aprobados a mano, con recarga en caliente y por MCP, y que el modo seguro ya
  apaga) **reciben ahora el mismo `tdt` de ganchos** que los plugins incluidos (`tdt.on`, `tdt.filter`, `tdt.register`, `tdt.do`), con el mismo cargador (id `dev:<nombre>`, para que ninguno
  pueda ocupar el sitio de uno incluido). Su `page.js` corre dentro de una función `async` (admite `await` al principio y `return () => …` para limpiar), un fallo se cuenta y se salta y con
  cinco se apaga solo ese plugin. El **inspector** muestra qué plugins con ganchos hay, su estado y sus fallos. Probado en la aplicación real (`scripts/plugin-lab/hooks.mjs`, 9 comprobaciones).
- Hecho también: **un usuario cualquiera instala un plugin con todo el poder** (`"tdt": {"api": 1, "full": {"page": "page.js"}}`, ver [PLUGINS.md](PLUGINS.md#plugins-con-todo-el-poder-los-que-se-instalan)) como
  cualquier otro (archivo, enlace o catálogo, con SHA-256 y firma de autor), **sin el modo desarrollador**. El aviso de instalación y el de activación dicen que tiene todo el poder y enseñan su código; la
  **aprobación es del código** (la huella de todos los archivos de su carpeta: una letra cambiada y vuelve a preguntar, y se vuelve a comprobar al entregarlo a la página); aparece en *Ajustes ▸ Plugins* como
  «Sin aislar», se puede empaquetar, y el modo seguro no lo carga. Probado en la aplicación real (`scripts/plugin-lab/full.mjs`, 15 comprobaciones).
- Hecho también: **una IA puede escribirlos** (`tdt_plugin_write`, nivel de desarrollo del MCP) con una ventana que dice «plugin con TODO el poder» o «tema» y enseña el código, y botones **Crear un tema** y
  **Crear un plugin con todo el poder** con plantillas que funcionan. Escribir no activa; activar es otra pregunta; y como la aprobación es del código, lo que se escriba después detiene al plugin hasta que se vuelva a activar.
- **Hito 2, empezado: la ranura `tile.overlay`** (capas sobre la imagen de cada casilla, `static/js/lib/overlays.js`). Un plugin registra `tdt.register('tile.overlay', id, { mount(ctx) { … return {el, update, destroy}; } })`;
  `mount` se llama una vez por casilla con `{tile: {index, focus, channel}, mode}` y devuelve un elemento (o nada, si no quiere esa casilla; se le vuelve a preguntar cuando algo cambia); `update(ctx)` se llama
  al cambiar el canal, el foco o la vista; al apagar el plugin, o reemplazar la capa por otra con el mismo id, se quita y se llama a `destroy`. La caja cubre la casilla, está por encima de la imagen y de
  la barra y **deja pasar todos los clics** (una capa que los quiere pone `pointer-events: auto`). Los registros avisan ahora de sus cambios (`hooks.watch`). Probado en 8 pruebas, en una página real y en
  la aplicación (`scripts/plugin-lab/hooks.mjs`). Faltan las demás ranuras (barra de la casilla, cabecera, fila de canal).
- **Hito 2: los temas completos** ([TEMAS.md](TEMAS.md)). Un plugin con todo el poder con `"full": {"css": "tema.css"}` es un **tema**: una hoja de estilo que se aplica después de la de la aplicación y que
  cambia cualquier regla, **sin ejecutar código**; sus imágenes y fuentes (de su carpeta, hasta 1 MB cada una y 4 MB) se incrustan en la hoja al entregarla; solo hay un tema a la vez; la pregunta de
  activación enseña la hoja y dice que es mucho menos que un plugin con código; la aprobación es de la huella de toda la carpeta. Con `page` además tiene código (`tdt.css(texto)` pone hojas desde un plugin).
  El **contrato** de qué nombres son estables (variables, clases, ids) está en TEMAS.md. Probado en la aplicación real (`scripts/plugin-lab/full.mjs`, 21 comprobaciones) y con 8 pruebas nuevas. Faltan las
  **plantillas** (reemplazar la estructura de la casilla o de la fila) y los **temas hijo**.
- **Falta** para cerrar el hito 1: la parte de **servidor** (`server.py`): el cargador de Python existe y está probado, pero ningún plugin se carga todavía desde una carpeta; y los alcances **`main`** (Node) para los
  que se instalan, que necesitan su propia pregunta. 

Para escribir uno (hoy, desde código), un plugin de página es un módulo con `export default function setup(tdt)`; el de la publicidad es el ejemplo
([plugins/ads/page.js](../tdtlocal/static/plugins/ads/page.js)):

```js
export default function setup(tdt) {
  // un paso nuevo de la reacción a la publicidad: un cartel rojo mientras dure, que se quita solo al acabar
  tdt.register('ad.actions', 'banner', {
    run(ctx, step) {
      const el = document.createElement('div');
      el.textContent = step.text + ' · ' + ctx.channel.name;
      document.body.append(el);
      return { lift: () => el.remove() };
    },
  });
  tdt.filter('ad.reaction', (steps) => [...steps, { do: 'banner', text: 'Pausa de anuncios' }], 20);
}
```

## 7. Pendiente de decidir

- Si un plugin puede aportar un reproductor que **decodifique vídeo propio**. Hoy la política de seguridad (CSP y encabezados de recursos) lo impide en un marco aislado; con código de confianza dentro de la página deja de ser un
  problema técnico y pasa a ser solo una cuestión de qué se permite.
- Si el código de confianza del servidor corre **en el mismo proceso de Python** (supuesto actual) o en un proceso aparte.
- Cómo conviven los plugins del modo ligero con los de confianza en la lista y en los avisos de instalación.
