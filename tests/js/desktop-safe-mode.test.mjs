// Safe mode (desktop/lib/safe-mode.js): when it is entered, how the last runs are counted, and how the app is started again in or out of it.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CRASHES_FOR_SAFE_MODE, createCrashGuard, decide, relaunchArgs } from '../../desktop/lib/safe-mode.js';

test('safe mode is entered by a flag, by a variable, or after two bad exits in a row, and says why', () => {
  assert.deepEqual(decide({}), { safe: false, why: '', text: '' });
  assert.equal(decide({ argv: ['electron', '.', '--safe'] }).why, 'flag');
  assert.equal(decide({ env: { TDT_SAFE_MODE: '1' } }).why, 'env');
  assert.equal(decide({ env: { TDT_SAFE_MODE: '0' } }).safe, false);
  assert.equal(decide({ env: { TDT_SAFE_MODE: 'yes' } }).safe, false, 'only «1»');
  assert.equal(decide({ unclean: 1 }).safe, false, 'one bad exit is bad luck');
  assert.equal(decide({ unclean: CRASHES_FOR_SAFE_MODE }).why, 'crashes');
  assert.equal(decide({ unclean: 5 }).safe, true);
  assert.match(decide({ unclean: 2 }).text, /se cerró mal las dos últimas veces/);
  assert.equal(decide({ argv: ['--safe'], env: { TDT_SAFE_MODE: '1' }, unclean: 3 }).why, 'flag', 'the flag is the most explicit');
  assert.equal(CRASHES_FOR_SAFE_MODE, 2);
});

test('the arguments to start again put the flag or take it away, once', () => {
  assert.deepEqual(relaunchArgs(['.'], true), ['.', '--safe']);
  assert.deepEqual(relaunchArgs(['.', '--safe'], true), ['.', '--safe']);
  assert.deepEqual(relaunchArgs(['.', '--safe', '--otra'], false), ['.', '--otra']);
  assert.deepEqual(relaunchArgs(['.'], false), ['.']);
});

test('a start after a run that never closed properly counts, a clean exit starts the count again, and a damaged marker is not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tdt-safe-'));
  try {
    const file = join(dir, 'sub', 'run.json');
    const guard = createCrashGuard(file);
    assert.equal(guard.start(), 0, 'the first start of all');
    assert.equal(createCrashGuard(file).start(), 1, 'the last run did not close: one bad exit');
    assert.equal(createCrashGuard(file).start(), 2, 'and again: two in a row');
    assert.equal(createCrashGuard(file).start(), 3);
    guard.cleanExit();
    assert.deepEqual(guard.peek(), { running: false, unclean: 0 });
    assert.equal(createCrashGuard(file).start(), 0, 'after a clean exit the count starts again');
    createCrashGuard(file).cleanExit();
    assert.equal(createCrashGuard(file).start(), 0, 'a clean exit between two starts: nothing to count');
    writeFileSync(file, '{', 'utf8');
    assert.equal(createCrashGuard(file).start(), 0, 'a damaged marker');
    writeFileSync(file, JSON.stringify({ running: true, unclean: 'mucho' }), 'utf8');
    assert.equal(createCrashGuard(file).start(), 1, 'a count that is not a number is zero');
    writeFileSync(file, '[1]', 'utf8');
    assert.equal(createCrashGuard(file).start(), 0);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).running, true, 'the run in course is marked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
