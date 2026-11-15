# Temas

Un **tema** cambia cómo se ve TDT local por completo: colores, tamaños, tipografías, qué se ve y dónde. Es un plugin con todo el poder que solo trae una **hoja de estilo** y ningún código
([HACKEABLE.md](HACKEABLE.md), [PLUGINS.md](PLUGINS.md#plugins-con-todo-el-poder-los-que-se-instalan)). Se instala, se activa y se comparte como cualquier plugin.

## Hacer uno

El botón **Crear un tema** (*Ajustes ▸ Plugins*) hace una carpeta que ya funciona, y una IA con acceso de desarrollo puede escribirlo por ti (`tdt_plugin_write`; verás la hoja de estilo antes de que nada se escriba). A mano:

Una carpeta (su nombre es el id: minúsculas, números y guiones) con dos archivos:

```json
{ "name": "Rojo", "version": "1.0.0", "author": "Ana", "tdt": { "api": 1, "full": { "css": "tema.css" } } }
```

```css
/* tema.css */
:root { --accent: #c0392b; --accent-ink: #fff; }
@media (prefers-color-scheme: dark) { :root { --accent: #e0705e; --accent-ink: #1a0f0d; } }
.tile-bar { backdrop-filter: blur(6px); }
body { background-image: url(fondo.png); }  /* una imagen de la carpeta: se mete dentro de la hoja al entregarla */
```

- **La hoja se aplica después de la de la aplicación**, así que gana en un empate. Se puede cambiar cualquier regla.
- **Los recursos** (imágenes `png jpg gif webp svg ico`, fuentes `woff woff2 ttf otf`, hasta 1 MB cada uno y 4 MB en total) tienen que estar **en la carpeta del tema**. La aplicación los incrusta
  como `data:` al entregar la hoja, porque la página no puede cargar nada de otro sitio. Una dirección con esquema (`https:`, `file:`), `//…` o `@import` es un problema y el tema no se activa.
- **Solo hay un tema a la vez**: activar uno apaga el anterior.
- **Un tema no ejecuta código.** Si además quieres código (una animación, un sonido, un gancho), añade `"page": "page.js"` y entonces es un plugin con todo el poder y se pregunta como tal
  (`"full": { "css": "tema.css", "page": "page.js" }`). Un `page.js` puede poner hojas con `tdt.css(texto)`.
- **Al activarlo se te enseña la hoja de estilo** y su huella; si cambia **una sola letra** de cualquier archivo de la carpeta (imágenes incluidas) deja de aplicarse hasta que se vuelva a activar.
  El modo seguro no aplica ninguno. Con una hoja de estilo se puede esconder un botón o poner algo encima de otra cosa: un tema solo es tan fiable como quien lo hizo.

## El contrato: qué es estable

Un tema depende de nombres que la aplicación no cambia sin decirlo en el [CHANGELOG](../CHANGELOG.md) (un nombre que cambia rompe a terceros). Lo que hay fuera de esta lista puede cambiar.

**Variables** (en `:root` de [style.css](../tdtlocal/static/style.css), con su versión oscura dentro de `@media (prefers-color-scheme: dark)`):
`--chassis`, `--panel`, `--ink`, `--muted`, `--line`, `--screen`, `--accent`, `--accent-ink`, `--row-hover`, `--ok`, `--bad`, `--unk` (colores) y `--font` (la tipografía).

**Estructura y clases** (las de [index.html](../tdtlocal/static/index.html) y las de la casilla):

| Pieza | Clases |
|---|---|
| Aplicación | `.app`, `.stage`, `.screen`, `.osd`, `.assist`, `.guide`, `.deck`, `.now`, `.controls`, `.panel`, `.panel-head`, `.panel-foot` |
| Lista de canales | `.list` (y sus `li`), `.seg`, `.filters`, `.toggles` |
| Botones | `.btn` (y `.btn.primary`) |
| Casillas | `.tiles` (`.single`, `.multi`, `.mosaic`, `.focus`), `.tile` (`.main`, `.alert`, `.yt`, `.audio`, `.rotating`), `.tile-bar`, `.tile-num`, `.tile-name`, `.tile-epg`, `.tile-clear`, `.tile-sub`, `.tile-cover`, `.tile-prog`, `.tile-adflag`, `.notice`, `.notice-actions`, `.tile-overlays` |
| Diálogos | `.dlg`, `.dlg-wide`, `.dlg-hint`, `.dlg-actions` |

Los `id` de `index.html` también son estables (`#list`, `#panel`, `#tiles`, `#btnMulti`…). El HTML que la aplicación construye con código (las filas de canal, la casilla) mantiene esas clases; **cambiar su
estructura interior** (qué elemento va dentro de cuál) **no está garantizado todavía**: eso llegará con las plantillas.

## Un ejemplo completo: Modern

[`ejemplos/tema-modern/`](ejemplos/tema-modern/) es un tema oscuro y redondeado que cambia casi toda la interfaz: botones con icono y aviso al
pasar el ratón, la barra bajo la imagen en una fila, Ajustes con las secciones en columna, y un `page.js` que pone el logo del canal junto a su
número. Su [LEEME](ejemplos/tema-modern/LEEME.md) explica cómo instalarlo. Lo que se aprendió al hacerlo, por si haces el tuyo:

- **Si das `display` a un elemento** (por ejemplo `.btn { display: inline-flex }`), tapas el atributo `hidden` con el que la aplicación esconde
  botones que no tocan (Quitar canal en un canal que no es tuyo, el Asistente sin IA…). Añade `[hidden] { display: none !important; }`.
- **Si la barra bajo la imagen crece**, añade `.stage { min-height: 0; }`: sin eso, la fila del reproductor no se encoge por debajo de 16:9 y la
  página se desplaza en ventanas bajas.
- **Para reordenar botones**, `order`: los de `.controls` y `.foot-actions` están en filas flex. Es solo visual: Tab sigue el orden de la página.
  Para que Tab siga el mismo orden, mueve los botones con `page.js` (la aplicación los busca por su `id`, no por su sitio) y devuélvelos a su
  sitio al apagar el plugin; Modern lo hace. Los plugins que se abren sobre la imagen añaden su botón al final de `.controls` (con
  `data-plugin`): si tu tema quita el texto de los botones, deja el de esos, que no tienen icono.
- **Para botones solo con icono**, deja el texto en la página con `font-size: 0` (los lectores de pantalla lo siguen leyendo) y pon el aviso en
  `::after` con `content: "Guía" / ""`: el `/ ""` evita que el aviso se lea dos veces.
- **Lo que una hoja no puede hacer** (copiar el logo de un canal a otro sitio), lo hace `page.js`; a cambio, el tema se aprueba como plugin con
  código.

## Qué falta

- **Plantillas** (reemplazar la casilla, la fila de un canal o la cabecera por otra estructura): hoy un tema cambia el aspecto, no la estructura.
- **Temas hijo** («como este, pero cambia esto»).
- Los **temas de colores** que ya existían (`tdt.themes` en el manifest de un plugin aislado, solo 12 colores) siguen igual; este es el tema completo.
