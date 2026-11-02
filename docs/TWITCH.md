# Twitch

La integración carga bajo demanda el SDK externo oficial `https://player.twitch.tv/js/embed/v1.js`, solo al abrir una fuente Twitch. No instala paquetes Python ni npm, pero requiere ese script y el servicio de Twitch para funcionar. La CSP permite esa URL de script y los marcos de `https://player.twitch.tv`.

Los enlaces de canales `https://www.twitch.tv/nombre` y los enlaces de `player.twitch.tv` de TDTChannels se abren con el SDK oficial de Twitch. El dominio `parent` se calcula desde la página local; no se reutiliza el de TDTChannels. Las fuentes alternativas siguen disponibles con sus botones numerados; se prefiere Twitch a una alternativa recordada para permitir las ventajas de la suscripción.

Para añadir otro canal, usa **Añadir canal**, escribe su nombre y pega el enlace de Twitch, sin cabeceras. El diálogo incluye un enlace al inicio de sesión oficial. En cada casilla de Twitch también aparece **Abrir en Twitch**.

Inicia sesión en Twitch en el mismo perfil del navegador y vuelve a TDT local. La sesión y las ventajas de suscripción las decide Twitch: esta integración no guarda contraseñas, cookies ni tokens, no consulta tu lista de suscripciones y no garantiza que el navegador permita reconocer una sesión dentro del reproductor incrustado. Si no reconoce tu cuenta, usa **Abrir en Twitch**. No se eluden anuncios ni restricciones.

En multivisión, **Escuchar** selecciona esa casilla. Se usa `setMuted` y `setVolume` del SDK oficial para silenciar las demás casillas y conservar el volumen elegido. La barra está fuera del reproductor; se mantiene un mínimo de 400 × 300 píxeles para el área de Twitch. El mosaico puede necesitar más espacio en ventanas pequeñas. El reproductor externo no admite el ecualizador local ni la transcripción de Whisper.

Las comprobaciones HLS no se aplican a Twitch. Un canal desconectado se indica como tal; no se confunde con una lista de vídeo defectuosa. Se permite hasta 45 segundos para inicializar el reproductor y se ofrece reintento si no responde.

Validación: pruebas de reconocimiento de URLs y rechazo de dominios parecidos, prioridad de Twitch con selección manual de alternativas, neutralización de comprobaciones antiguas y cambio de silencio mediante la API del reproductor. Las suscripciones necesitan verificación con la cuenta del usuario.

Fuentes: https://dev.twitch.tv/docs/embed/video-and-clips/ y https://discuss.dev.twitch.com/t/an-updated-twitch-embedded-player-viewer-experience/41718.
