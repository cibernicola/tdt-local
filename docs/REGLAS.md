# Reglas: «cuando pase esto, haz aquello», sin programar

Una regla dice **cuándo** y **qué hacer**. Sin código: son datos, y TDT local solo cumple las órdenes que ya sabe dar (poner un canal,
el volumen, un aviso…). Es el primer peldaño para modificar la aplicación a tu gusto; el siguiente son los
[plugins con permisos](HACER-PLUGINS.md).

**Dónde:** botón **Reglas** de la barra de controles. Se editan como texto (JSON); el botón *Ejemplo* añade uno para copiar y
*Lo que han hecho* enseña las últimas reglas cumplidas. Se guardan en `data/rules.json`. Funcionan mientras TDT local está abierto.

## Una regla

```json
{
  "id": "noticias-de-las-21",
  "name": "Noticias a las 21",
  "enabled": true,
  "when": { "type": "time", "at": "21:00", "days": [1, 2, 3, 4, 5] },
  "do": [
    { "action": "play", "channel": "La 1" },
    { "action": "volume", "value": 0.4 },
    { "action": "toast", "text": "Empieza el Telediario" }
  ]
}
```

- `id`: minúsculas, números y guiones (hasta 40). `name` es opcional; `enabled: false` la apaga sin borrarla.
- Hasta **50 reglas** y **5 acciones** por regla. Las acciones se hacen en orden; si una falla, las demás se hacen igualmente.
- Los canales se nombran por su **nombre** (sin importar mayúsculas ni tildes) o por su id.

## Cuándo (`when`)

| `type` | Campos | Salta… |
|---|---|---|
| `time` | `at` (`"21:30"`), `days` (opcional, 0 = domingo … 6 = sábado) | a esa hora, una vez por minuto |
| `key` | `key` (`"Alt+1"`, `"Ctrl+Shift+F5"`) | al pulsar esa tecla. **Siempre con Ctrl o Alt** (así no choca con las teclas de la página ni con escribir), más una letra, un número o F1 a F12. No salta mientras escribes en un campo ni con un diálogo abierto |
| `channel` | `channel` | cuando ese canal pasa a ser el que se ve (no al arrancar, ni si lo pone otra regla) |
| `programme` | `title` (texto que contiene), `channel` (opcional) | cuando empieza un programa con ese texto en la guía, en el canal que digas o en cualquiera |

## Qué hacer (`do`)

| `action` | Campos |
|---|---|
| `play` | `channel` |
| `kind` | `kind`: `tv`, `radio` o `u7d` |
| `volume` | `value` entre 0 y 1 |
| `mute` | `on`: `true` o `false` |
| `multi` | `channels` (de 1 a 4), `rotate` (segundos, 5 a 600, opcional) |
| `toast` | `text` (aviso en pantalla, hasta 200 caracteres) |

## Reglas que trae un plugin

Un plugin puede traer sus propias reglas (un atajo de teclado, por ejemplo) en `tdt.rules` de su manifest, con el mismo formato (hasta 10):

```json
"tdt": { "api": 1, "rules": [
  { "id": "volumen-bajo", "name": "Volumen bajo", "when": { "type": "key", "key": "Alt+9" },
    "do": [ { "action": "volume", "value": 0.27 }, { "action": "toast", "text": "Volumen bajo" } ] }
] }
```

**Están apagadas hasta que las enciendes tú**: salen en el diálogo *Reglas*, en «Reglas que traen los plugins», con su frase («Volumen bajo: al pulsar
Alt+9 → volumen al 27 %…») y una casilla. Lo que el plugin ponga en `enabled` no cuenta: decides tú, y tu elección se guarda aunque el plugin se
reinicie. Se apagan solas si el plugin se apaga. No hay código: son las mismas órdenes de siempre, y el servidor las comprueba como las tuyas.

## Eventos: lo que pasa, para quien quiera oírlo

Las reglas son una forma de reaccionar; los **eventos** son lo que pasa, contado a quien se suscriba: un plugin con `tdt.on(...)`
([HACER-PLUGINS.md](HACER-PLUGINS.md)), y una IA con `tdt_events` (lo último que ha pasado). Hoy hay cuatro: `channel.changed`,
`kind.changed`, `volume.changed` y `programme.started` (este, en los canales que estás viendo). **Lo que hace una regla se cuenta
también, marcado con `cause: "rule"`**, para que nadie lo confunda con algo que hiciste tú. `tdt_commands` lista todo lo que se puede
hacer y todo lo que se cuenta, con sus argumentos: es la lista única que comparten reglas, plugins, el bus y el MCP.

## Límites, para que no se líen solas

- Una regla **no se repite en menos de 10 segundos**, y una misma ocasión (el mismo minuto, el mismo programa) salta una sola vez.
- Lo que hace una regla **no dispara** las reglas por canal: dos reglas no pueden turnarse sin fin.
- No hay código, ni red, ni acceso a archivos: nada de lo que escribas aquí puede hacer más que lo que un botón hace.

## Por MCP (para que una IA te las escriba)

- `tdt_rules_get` (nivel «leer»): las reglas, cada una con su frase.
- `tdt_rules_set` (nivel «controlar»): **sustituye todas** (lee antes y devuelve también las que no cambian). Se comprueban antes de
  molestarte y **te las enseña una ventana del sistema, con lo que cambia, antes de guardar**. Solo en la aplicación de escritorio.

Ejemplo de petición: «avísame cuando empiece algo de fútbol en cualquier canal y baja el volumen a las 23:00 entre semana».
