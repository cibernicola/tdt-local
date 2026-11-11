// The helpers that package the desktop app (desktop/lib/pack.js). Nothing is packaged here.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { KEPT_LOCALES, iconFor, localesToRemove, pluginDirs, readVersion, stageExtras, strayLinks, trimLocales, versionFrom } from '../../desktop/lib/pack.js';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SERVER = process.platform === 'win32' ? 'tdt-local-server.exe' : 'tdt-local-server';

function temp() {
  const root = mkdtempSync(join(tmpdir(), 'tdt-pack-'));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('the version is read from tdtlocal/__init__.py and matches the desktop package', () => {
  assert.equal(versionFrom('"""doc"""\n\n__version__ = "1.2.3"\n'), '1.2.3');
  assert.equal(versionFrom("__version__ = '0.9'"), '0.9');
  assert.throws(() => versionFrom('nothing here'), /__version__/);
  const real = readVersion(REPO);
  assert.match(real, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(readFileSync(join(REPO, 'desktop', 'package.json'), 'utf8')).version, real);
});

test('only Spanish and English locales are kept', () => {
  const files = ['en-US.pak', 'es.pak', 'es-419.pak', 'fr.pak', 'zh-CN.pak', 'readme.txt'];
  assert.deepEqual(localesToRemove(files), ['fr.pak', 'zh-CN.pak']);
  assert.ok(KEPT_LOCALES.has('es.pak') && KEPT_LOCALES.has('en-US.pak'));
});

test('trimLocales deletes the others and is harmless without a locales folder', () => {
  const { root, done } = temp();
  try {
    assert.equal(trimLocales(root), 0);
    mkdirSync(join(root, 'locales'));
    for (const name of ['en-US.pak', 'es.pak', 'de.pak', 'ja.pak']) writeFileSync(join(root, 'locales', name), 'x');
    assert.equal(trimLocales(root), 2);
    assert.deepEqual(readdirSync(join(root, 'locales')).sort(), ['en-US.pak', 'es.pak']);
  } finally {
    done();
  }
});

test('the plugins that come with the app are the folders of tools/ with a manifest', () => {
  const found = pluginDirs(join(REPO, 'tools'));
  assert.ok(found.includes('puente-atresplayer') && found.includes('atresplayer-u7d'));
  assert.ok(!found.includes('capturar-directo.js'));
});

test('stageExtras lays out server/, plugins/ and icon.png, and refuses to run without the frozen server', () => {
  const { root, done } = temp();
  try {
    const server = join(root, 'frozen');
    assert.throws(() => stageExtras({ repoRoot: REPO, serverDir: server, stageDir: join(root, 'stage') }), /--server-only/);
    mkdirSync(join(server, '_internal'), { recursive: true });
    writeFileSync(join(server, SERVER), 'binary');
    writeFileSync(join(server, '_internal', 'lib.dll'), 'x');
    const stage = join(root, 'stage');
    const extras = stageExtras({ repoRoot: REPO, serverDir: server, stageDir: stage });
    assert.deepEqual(extras.map((p) => p.slice(stage.length + 1)), ['server', 'plugins', 'icon.png']);
    assert.ok(existsSync(join(stage, 'server', SERVER)) && existsSync(join(stage, 'server', '_internal', 'lib.dll')));
    assert.ok(existsSync(join(stage, 'plugins', 'puente-atresplayer', 'manifest.json')));
    assert.ok(existsSync(join(stage, 'icon.png')));
    stageExtras({ repoRoot: REPO, serverDir: server, stageDir: stage }); // running again replaces the stage
  } finally {
    done();
  }
});

test('the executable icon is the .ico or .icns of packaging/icons, and none on Linux', () => {
  assert.ok(iconFor('win32', REPO).endsWith('icon'));
  assert.ok(existsSync(iconFor('win32', REPO) + '.ico'));
  assert.ok(existsSync(iconFor('darwin', REPO) + '.icns'));
  assert.equal(iconFor('linux', REPO), undefined);
});

test('the relative links of the frozen server arrive as relative links, and a link that would break stops the package', (t) => {
  const { root, done } = temp();
  try {
    const server = join(root, 'frozen');
    mkdirSync(join(server, '_internal', 'Python.framework', 'Versions', '3.12'), { recursive: true });
    writeFileSync(join(server, SERVER), 'binary');
    writeFileSync(join(server, '_internal', 'Python.framework', 'Versions', '3.12', 'Python'), 'lib');
    try {
      symlinkSync(join('Python.framework', 'Versions', '3.12', 'Python'), join(server, '_internal', 'Python'));
    } catch {
      t.skip('this system does not allow symbolic links');
      return;
    }
    const stage = join(root, 'stage');
    stageExtras({ repoRoot: REPO, serverDir: server, stageDir: stage });
    const link = join(stage, 'server', '_internal', 'Python');
    assert.equal(readlinkSync(link), join('Python.framework', 'Versions', '3.12', 'Python'), 'still the relative text, not a path of this machine');
    assert.deepEqual(strayLinks(join(stage, 'server')), []);
    // one that points at the machine that built it, or out of the folder
    symlinkSync(join(root, 'frozen', 'tdt-local-server'), join(server, '_internal', 'absoluto'));
    symlinkSync(join('..', '..', 'fuera'), join(server, '_internal', 'sale'));
    assert.deepEqual(strayLinks(server).map((l) => l.link).sort(), [join('_internal', 'absoluto'), join('_internal', 'sale')]);
    assert.throws(() => stageExtras({ repoRoot: REPO, serverDir: server, stageDir: stage }), /enlaces que no valdrían/);
  } finally {
    done();
  }
});
