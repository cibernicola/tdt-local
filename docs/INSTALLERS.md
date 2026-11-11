# Instaladores

TDT local se distribuye como aplicación de escritorio para Windows, macOS y Linux. **Desde la versión 1.3.0** (las
anteriores, la 1.2.0 incluida, solo arrancan el servidor y abren tu navegador) cada instalador lleva
dentro la **aplicación de Electrón** (su propia ventana, con Chromium integrado) y el servidor con su propio
Python: **no hace falta tener nada instalado** para usarlo. Se crean con
[`@electron/packager`](https://github.com/electron/packager) y [PyInstaller](https://pyinstaller.org) desde
`packaging/build.py`, y la CI los publica en cada *release* (`.github/workflows/release.yml`). Pesan bastante
más que los de antes (del orden de cien megas, no diez): Chromium es casi todo. Cómo es la aplicación y qué
falta en [DESKTOP.md](DESKTOP.md).

| Sistema | Archivo | Cómo se instala |
|---|---|---|
| Windows 10/11 (x64) | `tdt-local-<versión>-windows-x64-setup.exe` | doble clic; por defecto en tu usuario, sin administrador |
| Windows | `tdt-local-<versión>-windows-x64-portable.zip` | descomprimir y ejecutar `tdt-local.exe` |
| macOS 11+ (Intel) | `tdt-local-<versión>-macos-x64.dmg` | arrastrar **TDT local** a Aplicaciones |
| macOS 11+ (Apple Silicon) | `tdt-local-<versión>-macos-arm64.dmg` | ídem |
| Debian / Ubuntu | `tdt-local_<versión>_amd64.deb` | `sudo apt install ./tdt-local_<versión>_amd64.deb` |
| Cualquier Linux | `tdt-local-<versión>-linux-x64.tar.gz` | descomprimir y `./install.sh` (en tu usuario, sin root) |

`SHA256SUMS.txt` lleva las huellas de todos los archivos.

## Cómo se comporta la aplicación instalada

- Al abrirla se abre **su propia ventana** (no tu navegador), con un icono en la bandeja, y arranca el servidor
  **sin ventana de consola**. Usa siempre el mismo puerto (el 8790 si está libre, y si no el siguiente hasta el
  8799) porque la página guarda favoritos, último canal y volumen por origen, y el puerto forma parte del
  origen. Si ya estaba abierta, el segundo lanzamiento muestra esa ventana.
- Para cerrarla, cierra la ventana, el botón **Salir** (abajo en el panel de canales) o «Salir» en la bandeja:
  paran también el servidor.
- **Plugins** (Ajustes ▸ Plugins) y **Registro** (Ajustes ▸ Registro) solo existen en esta aplicación; los que
  vienen incluidos están desactivados hasta que los actives.
- **Si actualizas desde una versión anterior** (la que abría tu navegador): en Windows el instalador la
  actualiza en el mismo sitio, y tus listas, canales propios y ajustes se conservan (misma carpeta de datos).
  Los **favoritos y el volumen que tuvieras en tu navegador no pasan**: son de otro perfil.
- Guarda sus datos por usuario, no en la carpeta de instalación:

  | Sistema | Datos |
  |---|---|
  | Windows | `%LOCALAPPDATA%\TDT local\` |
  | macOS | `~/Library/Application Support/TDT local/` |
  | Linux | `~/.local/share/tdt-local/` (o `$XDG_DATA_HOME/tdt-local/`) |

  Ahí están las listas, los canales propios, la caché de logos, el registro del servidor (`tdt-local.log`) y
  la carpeta `models/` para el modelo de Whisper; lo de la ventana (almacenamiento de la página, estado de
  los plugins y su Registro) va en la subcarpeta `desktop/`. `TDT_DATA_DIR` las cambia de sitio.
- Whisper y el asistente de IA son opcionales y **no se incluyen**. Se configuran desde **Ajustes** (el botón del panel
  de canales), que guarda todo en `settings.json` dentro de esa carpeta y permite descargar los modelos de Whisper;
  no hace falta tocar variables de entorno. Si defines alguna `TDT_*`, manda sobre lo guardado.
- Desinstalar: el desinstalador de Windows (pregunta si quieres borrar los datos), arrastrar la
  aplicación a la papelera en macOS, `sudo apt remove tdt-local` o `./uninstall.sh` en Linux.

## Qué verá el usuario al instalar (los paquetes no están firmados)

- **Windows:** SmartScreen avisa de «editor desconocido»: *Más información ➜ Ejecutar de todas formas*.
- **macOS:** Gatekeeper no abre apps sin notarizar con doble clic. La primera vez: clic derecho sobre
  la app ➜ **Abrir** ➜ **Abrir**; o en *Ajustes del Sistema ➜ Privacidad y seguridad ➜ Abrir igualmente*.
  La app lleva una firma *ad hoc* (necesaria en Apple Silicon), que no sustituye a una notarización.
- **macOS:** necesita **macOS 13 o superior** (lo exige Electrón desde su versión 44; la 11 y la 12 ya no valen).
- **Linux:** sin avisos. El `.deb` se construye en Ubuntu 22.04 y pide glibc 2.35 o superior, además de las
  bibliotecas gráficas de Chromium (GTK 3, NSS, etc.), que `apt` instala solo. Chromium necesita un ayudante de
  seguridad (`chrome-sandbox`) con permisos especiales: el `.deb` lo deja bien puesto; con el `.tar.gz`, que se
  instala sin root, el lanzador comprueba al arrancar si el sistema permite el aislamiento sin él y, si no,
  arranca con `--no-sandbox` (menos aislamiento).

Firmar quita esos avisos, pero requiere certificados de pago (Authenticode para Windows; Apple
Developer ID y notarización para macOS). Cuando existan, se añaden como secretos del repositorio y
pasos de `release.yml` (`signtool`, `codesign --options runtime`, `notarytool`).

## Construir en local

Hace falta compilar en cada sistema para ese sistema (ni PyInstaller ni el servidor congelado se compilan
de forma cruzada). Además de Python, hace falta **Node 20 o superior**.

```
python -m pip install pyinstaller certifi
python packaging/build.py
python packaging/smoke.py "dist/electron/TDT local-<sistema>-<arquitectura>"   # prueba de humo
```

`build.py` congela el servidor, empaqueta la app de Electrón (`npm ci` y `npm run pack` en `desktop/`) y la
convierte en cada instalador. `python packaging/build.py --classic` construye la aplicación de antes, la
que solo arranca el servidor y abre tu navegador.

Requisitos extra: en Windows, [Inno Setup 6](https://jrsoftware.org/isinfo.php) (`ISCC.exe`); en
macOS, las herramientas de línea de comandos de Xcode (`codesign`, `hdiutil`); en Linux, `dpkg-deb`
para el `.deb` (el `.tar.gz` se genera siempre). El resultado queda en `dist/installers/`.
`TDT_HOMEPAGE` cambia la dirección del proyecto que lleva el `.deb` (por defecto, este repositorio).

## Publicar una versión

1. Sube `__version__` en `tdtlocal/__init__.py` **y la `version` de `desktop/package.json`** (y la de
   `desktop/package-lock.json`; una prueba comprueba que coinciden) y anota los cambios en `CHANGELOG.md`.
2. `git tag v1.2.3 && git push --tags`.
3. La CI comprueba que el tag coincide con la versión, pasa las pruebas, construye los cuatro
   instaladores, prueba la app empaquetada (`packaging/smoke.py`; en Linux también el `.deb` ya instalado) y
   crea el *release* con ellos y con `SHA256SUMS.txt`.

## Licencias dentro de los instaladores

Cada instalador lleva `LICENSE-TDT-local.txt` (Apache 2.0), `NOTICE` (la cita de TDTChannels, hls.js, Electrón y
el resto), el `LICENSE` de Electrón (MIT) y `LICENSES.chromium.html` (las de Chromium), y dentro de
`resources/server/licenses/PYTHON-LICENSE.txt` la del intérprete de Python que se redistribuye. La propia
aplicación muestra los créditos en **Créditos y licencias** (`/about.html`). PyInstaller es GPL-2.0
con una excepción que permite distribuir los programas generados con cualquier licencia.

## Qué está comprobado

La CI construye los cuatro instaladores en cada ejecución de `release.yml` y, desde la 1.3.0 (la primera con Electrón),
pasa `packaging/smoke.py` a la app empaquetada en Windows, macOS y Linux y al `.deb` instalado. Eso comprueba que
arranca, sirve la página, cede el paso a un segundo lanzamiento y se cierra; no es una instalación en un equipo limpio.
**En la 1.5.0** se comprobó además, a mano en Windows, la app empaquetada con `scripts/plugin-lab/packaged.mjs` (22 comprobaciones): el paquete lleva
los archivos de la interfaz y de los plugins incluidos, la página corre y publica su estado, las órdenes y los eventos llegan, y el servidor MCP
por HTTP con el token ofrece las 30 herramientas y su escritor de plugins funciona a través del preload del paquete. No se pudo construir el
`setup.exe` en esa máquina (falta Inno Setup 6: lo construye la CI), y el **aviso nativo de activar un plugin** no lo ha visto ni pulsado nadie en
la app empaquetada (en el código fuente lo contestan las pruebas con una variable que el paquete no tiene).
Lo que sigue describe lo que se comprobó, a mano, de los instaladores de las versiones anteriores (los de la aplicación
que abría el navegador). Antes se
ejecutan las pruebas de Python en Linux, Windows y macOS. El paquete portable de Windows generado por la CI se
arrancó de verdad (servidor, API, créditos, ajustes y «Salir»). Los `.dmg`, el `.deb`, el `.tar.gz` y el
`setup.exe` se construyen bien, pero no se han instalado ni abierto en un macOS, un Linux o un Windows limpios:
si algo falla al instalar, abre una *issue* con el sistema y la versión.
