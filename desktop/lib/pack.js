// Helpers of desktop/build.mjs, apart so they can be tested without packaging anything. Nothing here needs Electron.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** The version of the program, from tdtlocal/__init__.py (the same file build.py and the release check read). */
export function versionFrom(initText) {
  const match = /^__version__\s*=\s*["']([^"']+)["']/m.exec(initText);
  if (!match) throw new Error('no se encuentra __version__ en tdtlocal/__init__.py');
  return match[1];
}

/** Chromium locales kept in the package (Windows and Linux): the interface is in Spanish, with English as fallback. */
export const KEPT_LOCALES = new Set(['en-US.pak', 'es.pak', 'es-419.pak']);

/** The `locales/*.pak` files of an extracted Electron that can go. */
export function localesToRemove(files) {
  return files.filter((name) => name.endsWith('.pak') && !KEPT_LOCALES.has(name));
}

/** Delete the Chromium locales we do not show. Returns how many it removed. */
export function trimLocales(electronDir) {
  const dir = join(electronDir, 'locales');
  if (!existsSync(dir)) return 0;
  const gone = localesToRemove(readdirSync(dir));
  for (const name of gone) rmSync(join(dir, name));
  return gone.length;
}

/** The folders of `toolsDir` that are plugins (they have a manifest.json). */
export function pluginDirs(toolsDir) {
  return readdirSync(toolsDir)
    .filter((name) => statSync(join(toolsDir, name)).isDirectory() && existsSync(join(toolsDir, name, 'manifest.json')))
    .sort();
}

/**
 * The symbolic links under `root` that would break once the folder is moved to another machine: the ones with an absolute target
 * and the ones that go out of `root`. A frozen server for macOS and Linux has relative links of its own (a library with several
 * names); they have to arrive as they are.
 * @returns {{link: string, target: string}[]}
 */
export function strayLinks(root) {
  const stray = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink()) {
        const target = readlinkSync(path);
        const inside = relative(root, resolve(dirname(path), target));
        if (isAbsolute(target) || inside.startsWith('..') || isAbsolute(inside)) stray.push({ link: relative(root, path), target });
      } else if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return stray;
}

/**
 * What goes next to the app (`resources/`): the frozen server as `server/`, the plugins that come with it as
 * `plugins/<name>/` and the icon of the tray and windows as `icon.png`. Returns the paths to hand to the packager.
 */
export function stageExtras({ repoRoot, serverDir, stageDir }) {
  if (!existsSync(join(serverDir, process.platform === 'win32' ? 'tdt-local-server.exe' : 'tdt-local-server'))) {
    throw new Error(`no hay servidor congelado en ${serverDir}: ejecuta antes «python packaging/build.py --server-only»`);
  }
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  // verbatimSymlinks: without it Node rewrites each relative link as an absolute path to the folder it was copied from, which on
  // another machine points nowhere (the frozen server of macOS and Linux has several)
  cpSync(serverDir, join(stageDir, 'server'), { recursive: true, verbatimSymlinks: true });
  const stray = strayLinks(join(stageDir, 'server'));
  if (stray.length) {
    throw new Error('el servidor congelado tiene enlaces que no valdrían en otro equipo: ' + stray.slice(0, 5).map((l) => `${l.link} → ${l.target}`).join('; '));
  }
  const plugins = join(stageDir, 'plugins');
  mkdirSync(plugins);
  for (const name of pluginDirs(join(repoRoot, 'tools'))) cpSync(join(repoRoot, 'tools', name), join(plugins, name), { recursive: true });
  cpSync(join(repoRoot, 'packaging', 'icons', 'icon-256.png'), join(stageDir, 'icon.png'));
  return [join(stageDir, 'server'), plugins, join(stageDir, 'icon.png')];
}

/** The icon of the executable without extension, as the packager wants it (it adds .ico or .icns itself). */
export function iconFor(platform, repoRoot) {
  const icons = join(repoRoot, 'packaging', 'icons');
  if (platform === 'win32' || platform === 'darwin') return join(icons, 'icon');
  return undefined; // Linux takes the icon of the .desktop entry, not of the executable
}

export function readVersion(repoRoot) {
  return versionFrom(readFileSync(join(repoRoot, 'tdtlocal', '__init__.py'), 'utf8'));
}
