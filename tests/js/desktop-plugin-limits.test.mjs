// Memory and processor limits of the plugins (desktop/lib/plugin-limits.js): who owns which process, and when one has gone over.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS, attribute, createWatch, limitsFrom } from '../../desktop/lib/plugin-limits.js';

const frame = (pid, id) => ({ pid, url: id ? `tdt-plugin://${id}/index.html` : 'http://127.0.0.1:8790/' });
const metric = (pid, mb, cpu) => ({ pid, memory: { workingSetSize: mb * 1024 }, cpu: { percentCPUUsage: cpu } });

test('each process is attributed to the plugin whose frame lives in it, with memory in MB', () => {
  const list = attribute([frame(10, 'tiempo'), frame(11, 'ahora'), frame(1, null)], [metric(10, 120.4, 3.26), metric(11, 90, 0), metric(1, 400, 5)]);
  assert.deepEqual(list, [
    { id: 'tiempo', pid: 10, memoryMB: 120, cpuPercent: 3.3, shared: false },
    { id: 'ahora', pid: 11, memoryMB: 90, cpuPercent: 0, shared: false },
  ]);
  assert.deepEqual(attribute([], []), []);
  assert.deepEqual(attribute(undefined, undefined), []);
  assert.deepEqual(attribute([frame(10, 'a')], []), [], 'no measure of that process: nothing to say');
  assert.deepEqual(attribute([{ pid: 'x', url: 'tdt-plugin://a/' }, { pid: 5, url: 'garbage' }], [metric(5, 1, 1)]), []);
});

test('the processor is read as a share of one core: Electron gives it as a share of all of them', () => {
  const one = [frame(10, 'a')];
  assert.equal(attribute(one, [metric(10, 100, 3.125)], 32)[0].cpuPercent, 100, 'a loop that fills one core of 32 reads 3.125 % and is 100 % of a core');
  assert.equal(attribute(one, [metric(10, 100, 25)], 4)[0].cpuPercent, 100);
  assert.equal(attribute(one, [metric(10, 100, 50)], 1)[0].cpuPercent, 50, 'one core: as it is');
  assert.equal(attribute(one, [metric(10, 100, 50)])[0].cpuPercent, 50, 'without the number of cores: as it is');
  assert.equal(attribute(one, [metric(10, 100, 50)], 0)[0].cpuPercent, 50, 'a nonsense number of cores is one');
  assert.equal(attribute(one, [metric(10, 100, 6.25)], 32)[0].cpuPercent, 200, 'two cores busy are 200 %');
});

test('a process shared with another plugin or with the page is marked, because what it uses is not only one plugin\'s', () => {
  const two = attribute([frame(10, 'a'), frame(10, 'b')], [metric(10, 500, 90)]);
  assert.deepEqual(two.map((p) => [p.id, p.shared]), [['a', true], ['b', true]]);
  const withPage = attribute([frame(10, 'a'), frame(10, null)], [metric(10, 500, 90)]);
  assert.equal(withPage[0].shared, true);
});

test('too much memory in two looks in a row is reported once, and a spike is not', () => {
  const watch = createWatch({ ...DEFAULT_LIMITS, memoryMB: 300 });
  const at = (mb) => [{ id: 'p', pid: 1, memoryMB: mb, cpuPercent: 0, shared: false }];
  assert.deepEqual(watch.look(at(250)), []);
  assert.deepEqual(watch.look(at(450)), [], 'one look is a spike');
  assert.deepEqual(watch.look(at(200)), [], 'and it went down');
  assert.deepEqual(watch.look(at(450)), []);
  const second = watch.look(at(460));
  assert.equal(second.length, 1);
  assert.equal(second[0].reason, 'memory');
  assert.match(second[0].detail, /460 MB.*300 MB/);
  assert.deepEqual(watch.look(at(470)), [], 'reported once while it stays');
});

test('a plugin restarted in a process that kept its memory is not stopped again for what was already there, only for what it adds', () => {
  const watch = createWatch({ ...DEFAULT_LIMITS, memoryMB: 300, growthMB: 150 });
  const at = (mb) => [{ id: 'p', pid: 1, memoryMB: mb, cpuPercent: 0, shared: false }];
  watch.look(at(100));
  watch.look(at(600));
  assert.equal(watch.look(at(620)).length, 1, 'it grew from 100 to 620');
  watch.look([]); // stopped
  assert.deepEqual(watch.look(at(610)), [], 'restarted in the same process: 610 MB are already there');
  assert.deepEqual(watch.look(at(615)), []);
  assert.deepEqual(watch.look(at(620)), []);
  assert.deepEqual(watch.look(at(700)), [], 'a little more is not a leak');
  watch.look(at(1100));
  const again = watch.look(at(1150));
  assert.equal(again.length, 1, 'but 500 MB more are');
  assert.match(again[0].detail, /el proceso ya tenía 610 MB al arrancar/);
});

test('when the process gives its memory back, growth is counted from the lowest it has been', () => {
  const watch = createWatch({ ...DEFAULT_LIMITS, memoryMB: 300, growthMB: 150 });
  const at = (mb) => [{ id: 'p', pid: 1, memoryMB: mb, cpuPercent: 0, shared: false }];
  watch.look(at(100));
  watch.look(at(600));
  watch.look(at(610));
  watch.look([]); // stopped
  assert.deepEqual(watch.look(at(607)), [], 'restarted in a process that still holds it');
  assert.deepEqual(watch.look(at(607)), []);
  assert.deepEqual(watch.look(at(106)), [], 'the process gave it back');
  watch.look(at(606));
  assert.equal(watch.look(at(610)).length, 1, 'and 500 MB again are a leak again');
});

test('a processor burnt without a pause for long enough is reported, and a pause starts the count again', () => {
  let clock = 0;
  const watch = createWatch({ ...DEFAULT_LIMITS, cpuPercent: 80, cpuSeconds: 20 }, () => clock);
  const at = (cpu) => [{ id: 'p', pid: 1, memoryMB: 100, cpuPercent: cpu, shared: false }];
  assert.deepEqual(watch.look(at(95)), []);
  clock = 15_000;
  assert.deepEqual(watch.look(at(95)), []);
  clock = 17_000;
  assert.deepEqual(watch.look(at(10)), [], 'a pause');
  clock = 30_000;
  assert.deepEqual(watch.look(at(95)), [], 'the count starts again');
  clock = 49_000;
  assert.deepEqual(watch.look(at(95)), []);
  clock = 51_000;
  const out = watch.look(at(97));
  assert.equal(out[0].reason, 'cpu');
  assert.match(out[0].detail, /21 s.*80 %/);
});

test('a plugin that was reported can be reported again after its frame went away and came back, if it grows again', () => {
  const watch = createWatch({ ...DEFAULT_LIMITS, memoryMB: 100, growthMB: 150 });
  const at = (mb) => [{ id: 'p', pid: 1, memoryMB: mb, cpuPercent: 0, shared: false }];
  watch.look(at(500));
  assert.equal(watch.look(at(500)).length, 1);
  assert.deepEqual(watch.look([]), [], 'its frame is gone');
  assert.deepEqual(watch.look(at(500)), [], 'it came back in a process that still holds 500 MB: that is not new');
  assert.deepEqual(watch.look(at(500)), []);
  watch.look(at(800));
  assert.equal(watch.look(at(820)).length, 1, 'but 300 MB more are');
});

test('a process that is not only one plugin\'s is never blamed on it, and every plugin is judged on its own', () => {
  const watch = createWatch({ ...DEFAULT_LIMITS, memoryMB: 100 });
  const list = [{ id: 'a', pid: 1, memoryMB: 900, cpuPercent: 99, shared: true }, { id: 'b', pid: 2, memoryMB: 900, cpuPercent: 0, shared: false }, { id: 'c', pid: 3, memoryMB: 50, cpuPercent: 0, shared: false }];
  watch.look(list);
  assert.deepEqual(watch.look(list).map((v) => v.id), ['b']);
});

test('the limits are the usual ones, and a test run can lower them but an installed app cannot', () => {
  assert.deepEqual(limitsFrom({}, false), DEFAULT_LIMITS);
  assert.equal(limitsFrom({ TDT_LIMIT_MEMORY_MB: '150', TDT_LIMIT_CPU_SECONDS: '4', TDT_LIMIT_EVERY_MS: '1000' }, false).memoryMB, 150);
  assert.equal(limitsFrom({ TDT_LIMIT_MEMORY_MB: '150' }, true).memoryMB, DEFAULT_LIMITS.memoryMB, 'installed: the environment is ignored');
  assert.equal(limitsFrom({ TDT_LIMIT_MEMORY_MB: 'mucho' }, false).memoryMB, DEFAULT_LIMITS.memoryMB);
  assert.equal(limitsFrom({ TDT_LIMIT_MEMORY_MB: '-5' }, false).memoryMB, DEFAULT_LIMITS.memoryMB);
  assert.equal(limitsFrom({ TDT_LIMIT_GROWTH_MB: '50' }, false).growthMB, 50);
  assert.ok(DEFAULT_LIMITS.memoryMB >= 200 && DEFAULT_LIMITS.cpuSeconds >= 10 && DEFAULT_LIMITS.everyMs >= 1000);
});
