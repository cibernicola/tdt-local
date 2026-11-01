# Cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); el proyecto sigue
[SemVer](https://semver.org/lang/es/).

## [Sin publicar]

### Funciones
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

- **Atresplayer**: Antena 3, laSexta, Neox, Nova, Mega y Atreseries, con logo y guía de programación (la de TDTChannels
  no los trae; se completa con la EPG_dobleM, leyendo solo esos seis canales). Ruta `/api/atres`.
- **Mediaset con Widevine**: Telecinco, Cuatro, FDF, Energy, Divinity, Be Mad y Boing se reproducen en el navegador con
  Shaka Player y la CDM Widevine del propio navegador (rutas `/api/mediaset*`). El servidor solo reenvía manifiesto,
  segmentos y licencia con las cabeceras de la web de Mediaset; no extrae claves ni descifra.
- **Orden**: La 1, La 2, Antena 3, Cuatro, Telecinco y laSexta ocupan del 1 al 6, seguidas del resto de Mediaset y de
  Atresmedia.

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
