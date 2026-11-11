# Seguridad

## Antes de nada: sed prudentes

TDT local es una versión incipiente, de uso personal y «vibecodeada» con IA. Tiene defensas y pruebas, pero no ha
pasado ninguna auditoría: **supón que hay agujeros** y no lo expongas a internet. Que alguien los encuentre y me
avise es justo lo que se agradece. Gracias de antemano.

## Modelo de amenazas

TDT local está pensado para ejecutarse en **tu propio equipo**, escuchando solo en `127.0.0.1`.
Defiende de:

- páginas web de otros sitios que intenten usar el servidor local (comprobación de `Host`,
  `Origin` y `Sec-Fetch-Site`, y política `frame-ancestors 'none'`);
- *SSRF* a través del proxy (lista de hosts permitidos, solo `http(s)`, direcciones no públicas
  siempre bloqueadas, también en las redirecciones);
- cambios de configuración desde otros equipos de la red (los ajustes, la descarga de modelos y las pruebas de
  conexión solo aceptan peticiones del propio equipo, porque `whisper_bin` es un programa que se ejecuta);
- rutas fuera de `tdtlocal/static/` (*path traversal*);
- XML con entidades en las guías (se rechaza) y descargas de tamaño desmesurado (hay límites);
- respuestas inesperadas del modelo de IA (se validan; solo se aceptan acciones y canales ofrecidos).

**No** defiende, por diseño, de alguien con acceso a tu sesión o a tu red local cuando usas
`--lan`: ese modo no tiene autenticación y debe usarse solo en redes de confianza.

## Plugins, reglas y acceso de IAs (aplicación de escritorio)

Un plugin es código de otra persona que corre en tu equipo, y una IA conectada puede ser tan peligrosa como un plugin. **No instales plugins en los que no confíes**, igual que no instalarías un programa. Esto es lo que hay y lo que no hay:

**Cuatro clases de plugin, de menos a más poder** (detalle en [docs/PLUGINS.md](docs/PLUGINS.md)):

- *De página* (scripts en webs ajenas) y *con permisos* (un marco aislado: sin red, sin la aplicación, sin tus archivos; solo el SDK, y solo lo que declaró y tú concediste). **Aquí sí hay una caja**: se probó con un plugin hostil que intenta salir de ella, pero es código nuevo y nadie lo ha auditado.
- *Con todo el poder* (`tdt.full`, se instalan como los demás): **no hay caja.** Corren dentro de la página de TDT local y pueden ver y cambiar todo lo que ella ve y hace. Lo que lo sustituye: al activarlo se te enseña su código; la aprobación va atada a una huella de **todos** los archivos de su carpeta (una letra cambiada, y vuelve a preguntar); el código se vuelve a comprobar justo al entregarlo; solo llegan a la página de TDT local, nunca a otro sitio; y el modo seguro no carga ninguno. **Un plugin con todo el poder puede, por ejemplo, leer lo que ves, cambiar tus ajustes o intentar sacar lo que guardas.** Cosas concretas que hay que saber: (1) la política de la página (`connect-src 'self'`) limita sus peticiones directas, pero **no es una barrera de fiar**: hay rendijas, como la descarga que usa la instalación desde un enlace; (2) como la página es la que habla con la aplicación en nombre de los plugins aislados, uno con todo el poder **puede usar los permisos y leer los datos de los demás plugins activos**; (3) puede colgar la página con un bucle, y eso no cuenta como «cierre malo» (el modo seguro entra solo si la aplicación muere): sirve *Reiniciar en modo seguro* de la bandeja o arrancar con `--safe`. Un *tema* (solo una hoja de estilo, sin código) es mucho menos, pero con CSS se puede esconder un botón o poner algo encima de otro.
- *De desarrollo* (modo desarrollador): igual de sin caja y, además, con el proceso principal (Node: archivos, procesos y red de tu equipo). Solo se activan a mano, con el modo desarrollador, que dice en la cara lo que es.

**Quién decide.** Instalar, activar y volver a dar un permiso se responde en **ventanas nativas** que ninguna página ni ninguna IA puede pulsar. Instalar nunca activa. Una IA conectada por el MCP (con el nivel de desarrollo) puede **escribir** plugins, también con todo el poder y temas, y pedir que se active uno; pero cada escritura la confirma el usuario con el código a la vista, escribir no activa, y activar es otra ventana que vuelve a enseñar el código. No puede instalarlos ni activarlos por su cuenta.

**El acceso de IAs (bus de control y MCP).** Está **apagado por defecto**. Encendido, usa un token que solo conoce quien lo lee de tu carpeta de datos (en Linux y macOS con permisos de archivo restringidos; en Windows confía en que la carpeta de tu usuario ya es privada), tiene tres niveles (leer, controlar, desarrollo) y todo lo que hace un cliente queda en el registro. No lo enciendas si no vas a usarlo, y no des el nivel de desarrollo a una IA en la que no confíes.

**Los límites.** Un plugin que se pasa de memoria o de procesador se detiene, y uno que falla repetidamente se apaga solo; si algo deja la aplicación inservible, se puede arrancar **sin ningún plugin** (modo seguro, solo o con `--safe`). No hay firma obligatoria: las firmas de autor (clave anotada la primera vez, con aviso si cambia) y el SHA-256 de un catálogo ayudan a saber que un archivo es el que publicó su autor, **no** que sea de fiar. No hay tienda ni revisión de plugins.

**Lo que no se ha comprobado:** todo esto se ha probado en Windows; el MCP, con un cliente independiente y con Claude Code, pero no con Claude Desktop ni con otros; y los avisos nativos, con una variable de pruebas que contesta por el usuario y que no existe en la aplicación instalada.

## Cómo informar de una vulnerabilidad

Por favor, no publiques los detalles de entrada. Abre una *issue* que diga solo «he encontrado un problema de
seguridad» (sin explicar cuál) o escríbeme por el [hilo de Twitter](https://x.com/cibernicola_es/status/2116114114686627845), y acordamos cómo contármelo en privado. Si el
repositorio tiene activados los *avisos privados de seguridad* de GitHub (pestaña **Security** ➜
**Report a vulnerability**), mejor aún. Es un proyecto personal: contesto cuando puedo, normalmente en unos días.

## Versiones con soporte

Solo la última versión publicada.
