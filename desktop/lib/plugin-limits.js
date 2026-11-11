// How much memory and processor a plugin may use. A plugin with a page runs in a process of its own (about 100 MB), and a page that allocates without end or
// loops without rest would make the whole computer slow. The app looks at the processes every few seconds, attributes each one to its plugin and, when one goes over
// what is allowed, stops its frame and says so (the user can start it again). Pure functions: main.js feeds them what Electron measures.
import { parseAddress } from './plugin-protocol.js';

export const DEFAULT_LIMITS = {
  memoryMB: 300, // more than this, in two looks in a row (a spike while it loads is not a leak)...
  growthMB: 150, // ...and at least this much more than what the process held when the plugin (re)started: a restarted plugin often gets the same process, which keeps its memory for a while
  cpuPercent: 80, // of one processor core...
  cpuSeconds: 20, // ...for this long without a pause
  everyMs: 5000, // how often the processes are looked at
};

/**
 * Which process belongs to which plugin, and how it is doing.
 * @param {{pid: number, url: string}[]} frames the frames of the page (the pid of the process each one lives in)
 * @param {{pid: number, memory?: {workingSetSize?: number}, cpu?: {percentCPUUsage?: number}}[]} metrics what Electron measures (memory in KB)
 * @param {number} cores how many logical processors the machine has: Electron reports the processor as a share of ALL of them (a loop that fills one core of 32 reads 3 %),
 * and the limits are in «% of one core», so the reading is multiplied by this
 * @returns {{id: string, pid: number, memoryMB: number, cpuPercent: number, shared: boolean}[]} ``shared``: the process also hosts another plugin or page, so what it uses is not only this plugin's
 */
export function attribute(frames, metrics, cores = 1) {
  const byPid = new Map((metrics || []).map((m) => [m.pid, m]));
  const owners = new Map(); // pid -> the ids that live there
  for (const f of frames || []) {
    const mine = parseAddress(String(f.url || ''));
    if (!mine || !Number.isInteger(f.pid)) continue;
    if (!owners.has(f.pid)) owners.set(f.pid, new Set());
    owners.get(f.pid).add(mine.id);
  }
  const out = [];
  const others = new Set((frames || []).filter((f) => !parseAddress(String(f.url || ''))).map((f) => f.pid)); // pages of the app in the same process
  for (const [pid, ids] of owners) {
    const m = byPid.get(pid);
    if (!m) continue;
    for (const id of ids) {
      out.push({
        id, pid, memoryMB: Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024),
        cpuPercent: Math.round(((m.cpu && m.cpu.percentCPUUsage) || 0) * Math.max(1, cores) * 10) / 10, shared: ids.size > 1 || others.has(pid),
      });
    }
  }
  return out;
}

/**
 * The watch: give it each look and it says who went over. A plugin is reported once (until it has gone away and come back): what to do with it is the caller's.
 * @param {typeof DEFAULT_LIMITS} limits
 * @param {() => number} now
 */
export function createWatch(limits = DEFAULT_LIMITS, now = () => Date.now()) {
  const over = new Map(); // id -> {memory: consecutive looks, cpuSince: when it started to burn, baseline: what the process held when it was first seen}
  const reported = new Set();
  const penalized = new Set(); // plugins that were stopped once: if they come back they may find their old memory still in the process
  return {
    /** @returns {{id: string, reason: 'memory' | 'cpu', detail: string}[]} */
    look(perPlugin) {
      const t = now();
      const present = new Set();
      const violations = [];
      for (const p of perPlugin || []) {
        present.add(p.id);
        if (p.shared) continue; // a process that is not only this plugin's cannot be blamed on it
        // a plugin that was never stopped is judged by the plain limit (one that allocates a gigabyte at once is seen already at a gigabyte); one that
        // was stopped and comes back is judged by what it adds to what the process already held
        const state = over.get(p.id) || { memory: 0, cpuSince: 0, baseline: penalized.has(p.id) ? p.memoryMB : 0 };
        if (state.baseline) state.baseline = Math.min(state.baseline, p.memoryMB); // the process gave memory back: what counts is growth from the lowest it has been
        const grew = p.memoryMB - state.baseline;
        state.memory = p.memoryMB > limits.memoryMB && grew > (limits.growthMB ?? 0) ? state.memory + 1 : 0;
        state.cpuSince = p.cpuPercent > limits.cpuPercent ? state.cpuSince || t : 0;
        over.set(p.id, state);
        if (reported.has(p.id)) continue;
        if (state.memory >= 2) {
          reported.add(p.id);
          penalized.add(p.id);
          violations.push({ id: p.id, reason: 'memory', detail: `usa ${p.memoryMB} MB y el tope es ${limits.memoryMB} MB` + (state.baseline > 100 ? ` (el proceso ya tenía ${state.baseline} MB al arrancar)` : '') });
        } else if (state.cpuSince && t - state.cpuSince >= limits.cpuSeconds * 1000) {
          reported.add(p.id);
          violations.push({ id: p.id, reason: 'cpu', detail: `lleva ${Math.round((t - state.cpuSince) / 1000)} s por encima del ${limits.cpuPercent} % de un procesador (usa ${p.cpuPercent} %)` });
        }
      }
      for (const id of [...over.keys()]) {
        if (present.has(id)) continue; // the frame is gone (stopped, or the plugin was turned off): next time it starts clean
        over.delete(id);
        reported.delete(id);
      }
      return violations;
    },
  };
}

/** The limits to use: the defaults, and in a test run what the environment says (never in an installed app). */
export function limitsFrom(env, packaged) {
  if (packaged) return { ...DEFAULT_LIMITS };
  const number = (name, fallback) => (Number.isFinite(Number(env[name])) && Number(env[name]) > 0 ? Number(env[name]) : fallback);
  return {
    memoryMB: number('TDT_LIMIT_MEMORY_MB', DEFAULT_LIMITS.memoryMB), growthMB: number('TDT_LIMIT_GROWTH_MB', DEFAULT_LIMITS.growthMB), cpuPercent: number('TDT_LIMIT_CPU_PERCENT', DEFAULT_LIMITS.cpuPercent),
    cpuSeconds: number('TDT_LIMIT_CPU_SECONDS', DEFAULT_LIMITS.cpuSeconds), everyMs: number('TDT_LIMIT_EVERY_MS', DEFAULT_LIMITS.everyMs),
  };
}
