// The included plugin «ads»: what the application does during an ad break. It uses the same hooks any plugin gets (docs/HACKEABLE.md):
//   filter   ad.reaction   the steps of the reaction, from the user's choices in the settings; a plugin can add, remove or change steps
//   registry ad.actions    what each step does (flag, audio, channel, web, notice); a plugin can add its own, or replace one with the same name
// The engine (js/adbreak.js) finds out when a break starts and ends and runs the steps; the steps are here.
import { altChannel, duckedGain, startText } from '../../js/lib/adbreak.js';

/**
 * The steps the user's settings ask for. `replay`: the channel was just gone back to by loading it again, so its player starts with an ad of its own
 * (not a new break); `soft`: there was little programme before the ad, so it only gets the sound and the notice.
 * @returns {{do: string}[]}
 */
export function defaultReaction(cfg, { replay = false, soft = false } = {}) {
  const steps = [];
  if (cfg.flag) steps.push({ do: 'flag' });
  if (cfg.audio === 'mute') steps.push({ do: 'audio', mode: 'mute' });
  else if (cfg.audio === 'lower') steps.push({ do: 'audio', mode: 'lower', percent: cfg.lower_percent });
  if (cfg.screen === 'channel' && !replay && !soft) steps.push({ do: 'channel', channel: cfg.channel });
  else if (cfg.screen === 'web' && !soft) steps.push({ do: 'web', url: cfg.web_url });
  steps.push({ do: 'notice' });
  return steps;
}

/** The actions of the registry `ad.actions`. `run(ctx, step)` is given what js/adbreak.js says about the break and returns `{lift, settle}` to undo it. */
export const ACTIONS = {
  /** The «PUBLICIDAD» sign on the tile. */
  flag: {
    run(ctx) {
      ctx.tile.setAdFlag(true);
      return { lift: () => ctx.tile.setAdFlag(false) };
    },
  },

  /** Mute the sound or lower it; if the user touched the audio meanwhile and asked to get it back, it is theirs again when the break is over. */
  audio: {
    run(ctx, step) {
      ctx.tile.setDuck(step.mode === 'mute' ? { muted: true } : { gain: duckedGain(step.percent) });
      return {
        lift: () => ctx.tile.setDuck(null),
        settle() {
          const now = ctx.settings();
          if (ctx.b.audioTouched && now && now.on_touch === 'restore') ctx.host.setVolume(ctx.b.before);
        },
      };
    },
  },

  /** Watch another channel. Single view: the original keeps playing in the background (so it still tells when the break is over) and is put back by
   *  `unpark`; multi-view: the tile itself is switched, and nothing tells when the break is over. */
  channel: {
    run(ctx, step) {
      const alt = altChannel(ctx.host.channels(), step.channel);
      if (!alt || alt.id === ctx.channel.id) return undefined;
      ctx.altName = alt.name;
      ctx.b.park = ctx.host.park(ctx.tile, alt);
      if (!ctx.b.park) ctx.host.tune(alt);
      ctx.blind = !ctx.b.park;
      return { lift: (quiet) => { if (ctx.b.park) ctx.host.unpark(ctx.b.park, ctx.tile, quiet); } };
    },
  },

  /** Show a web page over the tile. */
  web: {
    run(ctx, step) {
      ctx.tile.showAdFrame(step.url);
      return { lift: () => ctx.tile.hideAdFrame() };
    },
  },

  /** The notice on the screen saying what is being done. */
  notice: {
    run(ctx) {
      ctx.host.say(ctx.soft
        ? startText({ ...ctx.cfg, screen: 'keep' }, '') + ' (poco programa antes: no se cambia de canal)'
        : startText(ctx.cfg, ctx.altName));
      return undefined;
    },
  },
};

/** @param {object} tdt - what the loader gives a plugin (js/lib/trusted.js) */
export default function setup(tdt) {
  for (const [name, action] of Object.entries(ACTIONS)) tdt.register('ad.actions', name, action);
  tdt.filter('ad.reaction', (steps, ctx) => [...steps, ...defaultReaction(ctx.cfg, ctx)], 10);
}
