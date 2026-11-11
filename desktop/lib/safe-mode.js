// Safe mode: the app starts without running any plugin, so that a plugin that breaks it cannot keep doing so. It is entered by hand (the flag `--safe`, the variable
// `TDT_SAFE_MODE=1`, or «Reiniciar en modo seguro») or by itself when the app has died twice in a row without closing properly. Nothing the user chose is lost: the plugins
// that were on stay on in their files and run again when the safe mode is left. Pure functions plus a small file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CRASHES_FOR_SAFE_MODE = 2;

const WHY = {
  flag: 'se pidió con --safe',
  env: 'se pidió con TDT_SAFE_MODE',
  crashes: 'la aplicación se cerró mal las dos últimas veces que arrancó con plugins',
};

/**
 * Should this start be in safe mode? ``{safe, why, text}``.
 * @param {{argv?: string[], env?: Record<string, string | undefined>, unclean?: number, threshold?: number}} input ``unclean``: starts in a row that did not end with a clean exit
 */
export function decide({ argv = [], env = {}, unclean = 0, threshold = CRASHES_FOR_SAFE_MODE } = {}) {
  const why = argv.includes('--safe') ? 'flag' : env.TDT_SAFE_MODE === '1' ? 'env' : unclean >= threshold ? 'crashes' : '';
  return { safe: !!why, why, text: why ? WHY[why] : '' };
}

/** The arguments to start the app again in or out of safe mode, from those it was started with (the first two are the program and the script, if any). */
export function relaunchArgs(argv, safe) {
  const rest = argv.filter((a) => a !== '--safe');
  return safe ? [...rest, '--safe'] : rest;
}

/**
 * The marker of how the last run ended, in a file of the data folder: at the start it says «running» and a clean exit says «not running». A start that finds
 * «running» is a start after a run that did not end properly (it was killed, or it crashed).
 */
export function createCrashGuard(file) {
  const read = () => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  };
  const write = (data) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(data), 'utf8');
    renameSync(file + '.tmp', file);
  };
  return {
    /** Call at the start: how many starts in a row ended badly, counting the last one. Marks this run as «running». */
    start() {
      const was = read();
      const unclean = was.running === true ? (Number.isInteger(was.unclean) && was.unclean >= 0 ? was.unclean : 0) + 1 : 0;
      write({ running: true, unclean });
      return unclean;
    },
    /** Call when the app closes properly (or when the user leaves the safe mode): the count starts again. */
    cleanExit() {
      write({ running: false, unclean: 0 });
    },
    peek: read,
  };
}
