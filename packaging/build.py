#!/usr/bin/env python3
"""Build the installers for the platform this runs on.

    python -m pip install pyinstaller          # certifi too, on macOS and Linux, for HTTPS certificates
    python packaging/build.py
    python packaging/build.py --server-only    # only dist/tdt-local-server/, the server the Electron app carries
    python packaging/build.py --classic        # the earlier app: the server alone that opens your browser

The installers carry the Electron app (desktop/) with the frozen server inside; it needs Node 20 or newer.

Windows : ``tdt-local-<version>-windows-x64-setup.exe`` (Inno Setup 6) and a portable ``.zip``
macOS   : ``tdt-local-<version>-macos-<arch>.dmg``
Linux   : ``tdt-local_<version>_<arch>.deb`` and ``tdt-local-<version>-linux-<arch>.tar.gz``

Everything lands in ``dist/installers/`` together with a ``SHA256SUMS-*.txt`` file. The packages are not signed:
see docs/INSTALLERS.md for what users will see and how to sign them.
"""

from __future__ import annotations

import hashlib
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGING = ROOT / "packaging"
BUILD = ROOT / "build"
DIST = ROOT / "dist"
OUT = DIST / "installers"
APP_NAME = "TDT local"
SLUG = "tdt-local"
SERVER_SLUG = "tdt-local-server"  # the server alone, for the Electron app (see docs/DESKTOP.md)
ELECTRON_OUT = DIST / "electron"

DESCRIPTION = (
    "Tune · Display · Tinker — local. Visor local de la TDT española y la radio, con guía, multivisión, subtítulos "
    "y asistente de IA local."
)
HOMEPAGE = os.environ.get("TDT_HOMEPAGE", "https://github.com/cibernicola/tdt-local")


def read_version() -> str:
    """Version from ``tdtlocal/__init__.py`` without importing the package."""
    for line in (ROOT / "tdtlocal" / "__init__.py").read_text(encoding="utf-8").splitlines():
        if line.startswith("__version__"):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise SystemExit("no se encuentra __version__ en tdtlocal/__init__.py")


def machine() -> str:
    """Normalised CPU name: ``x64`` or ``arm64`` (``amd64``/``arm64`` are used for .deb files)."""
    m = platform.machine().lower()
    return {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(m, m)


def deb_arch() -> str:
    return {"x64": "amd64", "arm64": "arm64"}.get(machine(), machine())


def artifact_name(version: str, target: str, ext: str) -> str:
    """``tdt-local-1.0.0-windows-x64-setup.exe`` style names (the .deb follows Debian's own convention)."""
    if ext == "deb":
        return f"{SLUG}_{version}_{deb_arch()}.deb"
    return f"{SLUG}-{version}-{target}.{ext}"


def deb_control(version: str, arch: str, installed_size_kb: int) -> str:
    return (
        f"Package: {SLUG}\n"
        f"Version: {version}\n"
        "Section: video\n"
        "Priority: optional\n"
        f"Architecture: {arch}\n"
        # what Electron (Chromium) loads; the second names are the ones Ubuntu 24.04 renamed (time_t transition)
        "Depends: libc6 (>= 2.35), libgtk-3-0 | libgtk-3-0t64, libnss3, libxss1, libxtst6, "
        "libatspi2.0-0 | libatspi2.0-0t64, libgbm1, libasound2 | libasound2t64, libuuid1\n"
        "Recommends: xdg-utils, ffmpeg\n"
        f"Installed-Size: {installed_size_kb}\n"
        "Maintainer: TDT local contributors <4579387+cibernicola@users.noreply.github.com>\n"
        + (f"Homepage: {HOMEPAGE}\n" if HOMEPAGE else "")
        + f"Description: {DESCRIPTION}\n"
        " Reproduce las listas públicas de TDTChannels desde un servidor local, sin las apps de cada cadena.\n"
    )


def desktop_entry(exec_path: str, icon: str) -> str:
    return (
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name={APP_NAME}\n"
        "GenericName=TDT y radio\n"
        f"Comment={DESCRIPTION}\n"
        f"Exec={exec_path}\n"
        f"Icon={icon}\n"
        "Terminal=false\n"
        "Categories=AudioVideo;Video;TV;Network;\n"
        "Keywords=tdt;tv;televisión;radio;iptv;\n"
    )


def deb_copyright() -> str:
    return (
        "Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\n"
        f"Upstream-Name: {APP_NAME}\n" + (f"Source: {HOMEPAGE}\n" if HOMEPAGE else "") + "\nFiles: *\n"
        "Copyright: 2026 TDT local contributors\n"
        "License: Apache-2.0\n\n"
        "License: Apache-2.0\n"
        " On Debian systems, the full text of the Apache License 2.0 can be found in\n"
        " /usr/share/common-licenses/Apache-2.0 and in /usr/share/doc/tdt-local/LICENSE.\n"
        " This package also bundles hls.js (Apache-2.0), the Python runtime (PSF License),\n"
        " Electron (MIT) and Chromium (see /opt/tdt-local/LICENSES.chromium.html);\n"
        " see /usr/share/doc/tdt-local/NOTICE.\n"
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def run(command: list[str | Path], **kwargs: object) -> None:
    print("+", " ".join(str(c) for c in command), flush=True)
    subprocess.run([str(c) for c in command], check=True, **kwargs)  # type: ignore[call-overload]


def python_licence() -> Path | None:
    """The PSF licence text that ships with this Python (the installers bundle the interpreter)."""
    prefix = Path(sys.base_prefix)
    for candidate in (prefix / "LICENSE.txt", prefix / "LICENSE", *sorted(prefix.glob("lib/python3*/LICENSE.txt"))):
        if candidate.is_file():
            return candidate
    return None


def pyinstaller(version: str, spec: str = "tdt-local.spec", name: str = SLUG) -> Path:
    """Freeze ``spec``; returns the directory with the result (``dist/<name>``, or the ``.app`` parent)."""
    env = dict(os.environ, TDT_VERSION=version)
    licence = python_licence()
    if not licence:  # the interpreter is redistributed inside the installer, so its licence must travel with it
        raise SystemExit(f"no se encuentra la licencia de Python en {sys.base_prefix}: no se puede publicar sin ella")
    staged = BUILD / "licenses" / "PYTHON-LICENSE.txt"  # PyInstaller data entries name a folder, not a file
    staged.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(licence, staged)
    env["TDT_PYTHON_LICENSE"] = str(staged)
    shutil.rmtree(BUILD / "pyinstaller", ignore_errors=True)
    run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            DIST,
            "--workpath",
            BUILD / "pyinstaller",
            PACKAGING / spec,
        ],
        env=env,
    )
    app_dir = DIST / name
    # PyInstaller 6 puts data files under _internal/: also leave the licences where a user will look for them
    (app_dir / "licenses").mkdir(exist_ok=True)
    shutil.copy2(staged, app_dir / "licenses" / staged.name)
    for name in ("LICENSE", "NOTICE"):
        shutil.copy2(ROOT / name, app_dir / name)
    return app_dir


def electron_app(version: str) -> Path:
    """Package the Electron app around the frozen server; returns the folder with the result.

    On Windows and Linux that is the app itself (``dist/electron/TDT local-<system>-<arch>/``); on macOS the folder that
    holds ``TDT local.app``. Our licence and NOTICE go next to Electron's own LICENSE, which must stay.
    """
    desktop = ROOT / "desktop"
    npm = shutil.which("npm")
    if not npm:
        raise SystemExit("Falta Node 20 o superior (npm no está en el PATH): hace falta para empaquetar la aplicación")
    shutil.rmtree(ELECTRON_OUT, ignore_errors=True)
    run([npm, "ci"], cwd=desktop)
    run([npm, "run", "pack", "--", "--server", DIST / SERVER_SLUG, "--out", ELECTRON_OUT], cwd=desktop)
    found = [d for d in ELECTRON_OUT.iterdir() if d.is_dir()]
    if len(found) != 1:
        raise SystemExit(f"se esperaba una carpeta en {ELECTRON_OUT} y hay {len(found)}")
    app_dir = found[0]
    shutil.copy2(ROOT / "NOTICE", app_dir / "NOTICE")
    shutil.copy2(ROOT / "LICENSE", app_dir / "LICENSE-TDT-local.txt")
    return app_dir


# ---------------------------------------------------------------------------------------------- Windows
def find_inno() -> Path:
    found = shutil.which("iscc") or shutil.which("ISCC")
    if found:
        return Path(found)
    for base in (os.environ.get("PROGRAMFILES(X86)"), os.environ.get("PROGRAMFILES"), os.environ.get("LOCALAPPDATA")):
        if base:
            for sub in ("Inno Setup 6", "Programs/Inno Setup 6"):
                candidate = Path(base) / sub / "ISCC.exe"
                if candidate.is_file():
                    return candidate
    raise SystemExit("Falta Inno Setup 6 (https://jrsoftware.org/isinfo.php): ISCC.exe no está en el PATH")


def portable_zip(version: str, app_dir: Path) -> Path:
    portable = OUT / artifact_name(version, f"windows-{machine()}-portable", "zip")
    with zipfile.ZipFile(portable, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(app_dir.rglob("*")):
            if file.is_file():
                archive.write(file, Path(APP_NAME) / file.relative_to(app_dir))
    return portable


def build_windows(version: str, app_dir: Path) -> list[Path]:
    portable = portable_zip(version, app_dir)  # needs nothing but the standard library: build it first
    setup = artifact_name(version, f"windows-{machine()}-setup", "exe")
    run(
        [
            find_inno(),
            f"/DAppVersion={version}",
            f"/DSourceDir={app_dir}",
            f"/DRepoDir={ROOT}",
            f"/DOutputDir={OUT}",
            f"/DOutputName={setup[:-4]}",
            PACKAGING / "windows" / "installer.iss",
        ]
    )
    return [OUT / setup, portable]


# ------------------------------------------------------------------------------------------------ macOS
def build_macos(version: str, app_dir: Path) -> list[Path]:
    app = next((p for p in (app_dir / f"{APP_NAME}.app", DIST / f"{APP_NAME}.app") if p.is_dir()), None)
    if app is None:
        raise SystemExit(f"no se ha generado {APP_NAME}.app")
    run(["codesign", "--force", "--deep", "--sign", "-", app])  # ad-hoc: Apple Silicon refuses unsigned code
    staging = BUILD / "dmg"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    shutil.copytree(app, staging / app.name, symlinks=True)
    (staging / "Applications").symlink_to("/Applications")
    for name in ("LICENSE", "NOTICE"):
        shutil.copy2(ROOT / name, staging / name)
    dmg = OUT / artifact_name(version, f"macos-{machine()}", "dmg")
    # hdiutil fails now and then with "Resource busy" on CI runners (a disk-image helper still holds the volume)
    for attempt in range(1, 6):
        try:
            run(["hdiutil", "create", "-volname", APP_NAME, "-srcfolder", staging, "-ov", "-format", "UDZO", dmg])
            break
        except subprocess.CalledProcessError:
            if attempt == 5:
                raise
            print(f"hdiutil falló (intento {attempt} de 5); se reintenta", flush=True)
            time.sleep(10)
    return [dmg]


# ------------------------------------------------------------------------------------------------ Linux
def _chmod_tree(root: Path) -> None:
    """Directories 755, executables 755, everything else 644 (what Debian policy expects)."""
    for path in [root, *root.rglob("*")]:
        if path.is_symlink():
            continue
        if path.is_dir() or os.access(path, os.X_OK):
            path.chmod(0o755)
        else:
            path.chmod(0o644)


def build_linux(version: str, app_dir: Path) -> list[Path]:
    artifacts = [_linux_deb(version, app_dir)] if shutil.which("dpkg-deb") else []
    artifacts.append(_linux_tarball(version, app_dir))
    return artifacts


def _linux_deb(version: str, app_dir: Path) -> Path:
    stage = BUILD / "deb"
    shutil.rmtree(stage, ignore_errors=True)
    opt = stage / "opt" / SLUG
    shutil.copytree(app_dir, opt, symlinks=True)
    (stage / "usr" / "bin").mkdir(parents=True)
    (stage / "usr" / "bin" / SLUG).symlink_to(f"/opt/{SLUG}/{SLUG}")
    apps = stage / "usr" / "share" / "applications"
    apps.mkdir(parents=True)
    (apps / f"{SLUG}.desktop").write_text(desktop_entry(f"/usr/bin/{SLUG}", SLUG), encoding="utf-8")
    for size in (48, 64, 128, 256, 512):
        target = stage / "usr" / "share" / "icons" / "hicolor" / f"{size}x{size}" / "apps"
        target.mkdir(parents=True)
        shutil.copy2(PACKAGING / "icons" / f"icon-{size}.png", target / f"{SLUG}.png")
    doc = stage / "usr" / "share" / "doc" / SLUG
    doc.mkdir(parents=True)
    for name in ("LICENSE", "NOTICE"):
        shutil.copy2(ROOT / name, doc / name)
    (doc / "copyright").write_text(deb_copyright(), encoding="utf-8")
    size_kb = sum(f.stat().st_size for f in stage.rglob("*") if f.is_file()) // 1024
    (stage / "DEBIAN").mkdir()
    (stage / "DEBIAN" / "control").write_text(deb_control(version, deb_arch(), size_kb), encoding="utf-8")
    _chmod_tree(stage)
    (stage / "DEBIAN").chmod(0o755)
    sandbox = opt / "chrome-sandbox"  # Chromium's sandbox helper must be setuid root (dpkg-deb --root-owner-group)
    if sandbox.exists():
        sandbox.chmod(0o4755)
    deb = OUT / artifact_name(version, "", "deb")
    run(["dpkg-deb", "--build", "--root-owner-group", stage, deb])
    return deb


INSTALL_SH = r"""#!/bin/sh
# Installs TDT local for the current user (no root needed). Remove it with uninstall.sh.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
dest="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p "$dest/tdt-local-app" "$HOME/.local/bin" "$dest/applications" "$dest/icons/hicolor/256x256/apps"
cp -R "$here/tdt-local/." "$dest/tdt-local-app/"
# Chromium's sandbox needs either a setuid helper (only root can set it) or unprivileged user namespaces. Without
# either the app cannot start, so the launcher checks at every start and only then falls back to --no-sandbox.
cat > "$HOME/.local/bin/tdt-local" <<EOF
#!/bin/sh
app="$dest/tdt-local-app"
flags=""
if [ ! -u "\$app/chrome-sandbox" ] && ! unshare --user true 2>/dev/null; then flags="--no-sandbox"; fi
exec "\$app/tdt-local" \$flags "\$@"
EOF
chmod 755 "$HOME/.local/bin/tdt-local"
cp "$here/icon.png" "$dest/icons/hicolor/256x256/apps/tdt-local.png"
sed "s|^Exec=.*|Exec=$HOME/.local/bin/tdt-local|" "$here/tdt-local.desktop" > "$dest/applications/tdt-local.desktop"
echo "TDT local instalado. Búscalo en el menú de aplicaciones o ejecuta: tdt-local"
"""

UNINSTALL_SH = """#!/bin/sh
dest="${XDG_DATA_HOME:-$HOME/.local/share}"
rm -rf "$dest/tdt-local-app" "$HOME/.local/bin/tdt-local" "$dest/applications/tdt-local.desktop" \\
  "$dest/icons/hicolor/256x256/apps/tdt-local.png"
echo "TDT local desinstalado. Tus datos siguen en $dest/tdt-local (bórralos si quieres)."
"""


def _linux_tarball(version: str, app_dir: Path) -> Path:
    stage = BUILD / "tarball" / f"{SLUG}-{version}"
    shutil.rmtree(stage.parent, ignore_errors=True)
    stage.mkdir(parents=True)
    shutil.copytree(app_dir, stage / SLUG, symlinks=True)
    shutil.copy2(PACKAGING / "icons" / "icon-256.png", stage / "icon.png")
    (stage / "tdt-local.desktop").write_text(desktop_entry(f"/usr/bin/{SLUG}", SLUG), encoding="utf-8")
    for name, text in (("install.sh", INSTALL_SH), ("uninstall.sh", UNINSTALL_SH)):
        (stage / name).write_text(text, encoding="utf-8")
        (stage / name).chmod(stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
    for name in ("LICENSE", "NOTICE"):
        shutil.copy2(ROOT / name, stage / name)
    tarball = OUT / artifact_name(version, f"linux-{machine()}", "tar.gz")
    with tarfile.open(tarball, "w:gz") as archive:
        archive.add(stage, arcname=stage.name)
    return tarball


# ---------------------------------------------------------------------------------------------- driver
BUILDERS = {"win32": build_windows, "darwin": build_macos, "linux": build_linux}


def main() -> int:
    if "--server-only" in sys.argv[1:]:  # just the server for the Electron app: dist/tdt-local-server/
        print(f"\nServidor: {pyinstaller(read_version(), 'tdt-local-server.spec', SERVER_SLUG)}")
        return 0
    builder = BUILDERS.get("linux" if sys.platform.startswith("linux") else sys.platform)
    if builder is None:
        print(f"plataforma no soportada: {sys.platform}", file=sys.stderr)
        return 1
    version = read_version()
    OUT.mkdir(parents=True, exist_ok=True)
    if "--classic" in sys.argv[1:]:  # the earlier app (opens your browser): one PyInstaller step
        app_dir = pyinstaller(version)
    else:
        pyinstaller(version, "tdt-local-server.spec", SERVER_SLUG)
        app_dir = electron_app(version)
    artifacts = builder(version, app_dir)
    sums = OUT / f"SHA256SUMS-{sys.platform.rstrip('0123456789')}-{machine()}.txt"  # one per runner; CI merges them
    existing = sums.read_text(encoding="utf-8").splitlines() if sums.exists() else []
    lines = [line for line in existing if line.split("  ", 1)[-1] not in {a.name for a in artifacts}]
    lines += [f"{sha256(a)}  {a.name}" for a in artifacts]
    sums.write_text("\n".join(sorted(lines, key=lambda s: s.split("  ", 1)[-1])) + "\n", encoding="utf-8")
    print("\nInstaladores:")
    for artifact in artifacts:
        print(f"  {artifact}  ({artifact.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
