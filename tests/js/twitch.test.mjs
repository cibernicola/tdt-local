import assert from 'node:assert/strict';
import { test } from 'node:test';
import { twitchChannel, twitchWeb, withTwitchSources, syncTwitchAudio } from '../../tdtlocal/static/js/lib/twitch.js';
import { audioTarget } from '../../tdtlocal/static/js/lib/adbreak.js';
import { buildPlan } from '../../tdtlocal/static/js/lib/plan.js';

test('Twitch feed URLs discard the old parent; channel links are supported', () => {
  assert.equal(twitchChannel('https://player.twitch.tv/?channel=Rubius&parent=play.tdtchannels.com'), 'rubius');
  assert.equal(twitchChannel('https://www.twitch.tv/ibai'), 'ibai');
  assert.equal(twitchWeb('https://player.twitch.tv/?channel=ibai'), 'https://www.twitch.tv/ibai');
  for (const url of ['https://twitch.tv.evil.com/ibai', 'https://twitch.tv@evil.com/ibai',
    'javascript:alert(1)', 'https://www.twitch.tv/directory', 'https://player.twitch.tv/?channel=x%26evil',
    'https://www.twitch.tv/videos/123', 'https://www.youtube.com/ibai']) assert.equal(twitchChannel(url), null);
});

test('old failed probes and a YouTube fallback cannot hide or bypass the official Twitch source', () => {
  const channel = { id: 'ibai', ok: false, sources: [
    { u: 'https://player.twitch.tv/?channel=ibai&parent=old.example', ok: false },
    { u: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/live', ok: true },
  ] };
  const result = withTwitchSources(channel);
  assert.equal(result.ok, null);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].ok, null);
  assert.equal(channel.ok, false);
  assert.equal(channel.sources.length, 2);
  assert.equal(buildPlan(result, { pref: channel.sources[1] })[0].u, channel.sources[0].u);
  assert.equal(buildPlan(result, { onlyUrl: channel.sources[1].u })[0].u, channel.sources[1].u);
  const ordinary = { sources: [{ u: 'https://stream.example/live.m3u8' }] };
  assert.equal(withTwitchSources(ordinary), ordinary);
});

test('switching the active tile mutes Twitch through its official API and restores the chosen volume', () => {
  const calls = [];
  const player = { setVolume: (v) => calls.push(['volume', v]), setMuted: (m) => calls.push(['muted', m]) };
  syncTwitchAudio(player, audioTarget({ v: 0.6, m: false }, null, false));
  assert.deepEqual(calls.at(-1), ['muted', true]);
  syncTwitchAudio(player, audioTarget({ v: 0.6, m: false }, null, true));
  assert.deepEqual(calls.slice(-2), [['volume', 0.6], ['muted', false]]);
  syncTwitchAudio(player, audioTarget({ v: 0.6, m: true }, null, true));
  assert.deepEqual(calls.at(-1), ['muted', true]);
});
