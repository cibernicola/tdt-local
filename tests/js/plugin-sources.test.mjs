// Playback sources that plugins add (tdt.sources + embed:server): what a manifest may declare and how an address becomes a player.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTROLS, MAX_SOURCES, describePermission, embedHosts, parsePermission, readSources, riskOf,
} from '../../desktop/lib/plugin-api.js';
import { CONTROLS as PAGE_CONTROLS, matchSource, patternOf } from '../../tdtlocal/static/js/lib/sources.js';

const TWITCH = { name: 'Twitch', match: 'https://www.twitch.tv/{1}', embed: 'https://player.twitch.tv/?channel={1}&parent={parent}' };
const ALLOW = ['embed:player.twitch.tv'];

test('«embed:server» is a permission with its own words and the highest risk, and it admits no wildcards or private names', () => {
  assert.deepEqual(parsePermission('embed:player.twitch.tv'), { embed: true, host: 'player.twitch.tv', name: 'embed:player.twitch.tv' });
  for (const wrong of ['embed:', 'embed:*.twitch.tv', 'embed:127.0.0.1', 'embed:localhost', 'embed:nas.local', 'embed:com', 'embed:a b.com']) {
    assert.ok(parsePermission(wrong).problem, wrong);
  }
  assert.equal(riskOf('embed:player.twitch.tv'), 'critical');
  assert.match(describePermission('embed:player.twitch.tv'), /reproductor de player\.twitch\.tv.*sus propios scripts/);
});

test('a source is read when its player server is one the plugin asked for', () => {
  assert.deepEqual(readSources([TWITCH], ALLOW), { list: [TWITCH], problems: [] });
  assert.deepEqual(readSources(undefined, []), { list: [], problems: [] });
  assert.match(readSources([TWITCH], []).problems[0], /pide «embed:player\.twitch\.tv»/);
  assert.match(readSources([TWITCH], ['embed:otro.twitch.tv']).problems[0], /pide «embed:player\.twitch\.tv»/);
});

test('what is wrong in a source is said in words, field by field', () => {
  const wrong = [
    ['x', /lista/], [Array.from({ length: MAX_SOURCES + 1 }, () => TWITCH), /lista/],
    [[5], /\{name, match, embed\}/], [[null], /\{name, match, embed\}/],
    [[{ ...TWITCH, name: '' }], /falta «name»/],
    [[{ ...TWITCH, match: 'no es una dirección' }], /direcciones https/],
    [[{ ...TWITCH, embed: 'tampoco' }], /direcciones https/],
    [[{ ...TWITCH, match: 'http://www.twitch.tv/{1}' }], /solo https/],
    [[{ ...TWITCH, embed: 'http://player.twitch.tv/?channel={1}' }], /solo https/],
    [[{ ...TWITCH, embed: 'https://{1}.twitch.tv/?c=x' }], /direcciones https|nunca en el servidor/],
    [[{ ...TWITCH, embed: 'https://player.twitch.tv/{parent}/x' }], /\{parent\} solo va después de «\?»/],
    [[{ ...TWITCH, embed: 'https://player.twitch.tv/?channel={4}' }], /huecos son/],
    [[{ ...TWITCH, match: 'https://www.twitch.tv/{1}' + 'a'.repeat(200) }], /demasiado largas/],
  ];
  for (const [raw, pattern] of wrong) {
    const r = readSources(raw, ALLOW);
    assert.equal(r.list.length, 0, JSON.stringify(raw).slice(0, 60));
    assert.ok(r.problems.some((p) => pattern.test(p)), `${JSON.stringify(raw).slice(0, 60)} → ${r.problems.join(' / ')}`);
  }
});

test('the servers a page may frame are exactly the ones approved for the plugins that run', () => {
  const plugins = [{ p: ['embed:player.twitch.tv', 'storage'] }, { p: ['embed:player.twitch.tv', 'embed:otro.tv'] }, { p: ['network:a.com'] }];
  assert.deepEqual(embedHosts(plugins, (x) => x.p), ['player.twitch.tv', 'otro.tv']);
  assert.deepEqual(embedHosts([], () => []), []);
});

test('an address becomes the player of the source that knows it, with the holes filled and the host that shows it', () => {
  assert.deepEqual(matchSource([TWITCH], 'https://www.twitch.tv/Shroud', '127.0.0.1'), { name: 'Twitch', embed: 'https://player.twitch.tv/?channel=Shroud&parent=127.0.0.1', control: '' });
  assert.equal(matchSource([TWITCH], 'https://www.twitch.tv/Shroud/', 'x').embed, 'https://player.twitch.tv/?channel=Shroud&parent=x', 'a final slash');
  assert.equal(matchSource([TWITCH], 'https://www.twitch.tv/shroud?sr=a#b', 'x').embed, 'https://player.twitch.tv/?channel=shroud&parent=x', 'a query or fragment');
  for (const other of ['https://www.twitch.tv/', 'https://www.twitch.tv/a/b', 'http://www.twitch.tv/a', 'https://evil.example/shroud', 'https://www.twitch.tv.evil.example/a', 'https://www.twitch.tv/a b', '', null, 'https://www.twitch.tv/' + 'a'.repeat(500)]) {
    assert.equal(matchSource([TWITCH], other, 'x'), null, String(other).slice(0, 40));
  }
  assert.equal(matchSource([], 'https://www.twitch.tv/a', 'x'), null);
  assert.equal(matchSource(undefined, 'https://www.twitch.tv/a', 'x'), null);
});

test('a hole takes a word, never the structure of the address: nothing can be smuggled in', () => {
  const evil = 'https://www.twitch.tv/a%26parent%3Devil.example';
  assert.equal(matchSource([TWITCH], evil, 'x'), null, 'a % is not part of a word');
  const wild = { name: 'W', match: 'https://a.example/{1}/{2}', embed: 'https://p.example/?x={1}&y={2}&parent={parent}' };
  assert.equal(matchSource([wild], 'https://a.example/uno/dos', 'h').embed, 'https://p.example/?x=uno&y=dos&parent=h');
  assert.equal(matchSource([wild], 'https://a.example/u..o/d~s', 'h').embed, 'https://p.example/?x=u..o&y=d~s&parent=h');
  assert.equal(matchSource([{ ...wild, embed: 'https://p.example/?x={1}&y={2}' }], 'https://a.example/a/b', 'h').embed, 'https://p.example/?x=a&y=b');
  assert.equal(patternOf('https://a.b/c.d').test('https://a.b/cXd'), false, 'a dot in the address is a dot');
});

test('a source whose player moved to another server shows nothing instead of the wrong place', () => {
  const sneaky = { name: 'S', match: 'https://a.example/{1}', embed: 'https://p.example/{1}' };
  assert.ok(matchSource([sneaky], 'https://a.example/x', 'h'));
  assert.equal(matchSource([{ ...sneaky, embed: 'http://p.example/{1}' }], 'https://a.example/x', 'h'), null, 'not https');
});

const YT = { name: 'YT', match: 'https://yt.example/{1}', embed: 'https://www.youtube-nocookie.com/embed/{1}', control: 'youtube' };

test('a source may ask for a control adapter the core knows, and only with the servers that adapter fits', () => {
  assert.deepEqual(CONTROLS, PAGE_CONTROLS, 'the manifest reader and the page know the same adapters and servers');
  const allow = ['embed:www.youtube-nocookie.com', 'embed:www.atresplayer.com', 'embed:player.twitch.tv'];
  assert.deepEqual(readSources([YT], allow).list, [YT]);
  assert.deepEqual(readSources([{ ...YT, embed: 'https://www.youtube.com/embed/{1}' }], ['embed:www.youtube.com']).list.length, 1);
  assert.deepEqual(readSources([{ name: 'A', match: 'https://a.example/{1}', embed: 'https://www.atresplayer.com/embed/live/{1}/', control: 'atres' }], allow).problems, []);
  for (const [bad, pattern] of [
    [{ ...YT, control: 'vlc' }, /«control» es youtube o atres/],
    [{ ...YT, control: 5 }, /«control» es youtube o atres/],
    [{ ...YT, embed: 'https://player.twitch.tv/?c={1}&parent={parent}' }, /solo vale con www\.youtube-nocookie\.com o www\.youtube\.com/],
    [{ ...YT, control: 'atres' }, /solo vale con www\.atresplayer\.com/],
  ]) {
    const r = readSources([bad], allow);
    assert.equal(r.list.length, 0, JSON.stringify(bad).slice(0, 60));
    assert.match(r.problems[0], pattern);
  }
  assert.equal(readSources([TWITCH], ALLOW).list[0].control, undefined, 'without «control» there is none: the sound of the player is its own');
});

test('the page gives the adapter only when the player really is on the server it fits', () => {
  assert.equal(matchSource([YT], 'https://yt.example/abc123', 'x').control, 'youtube');
  assert.equal(matchSource([TWITCH], 'https://www.twitch.tv/a', 'x').control, '');
  assert.equal(matchSource([{ ...YT, embed: 'https://player.twitch.tv/{1}' }], 'https://yt.example/abc', 'x').control, '', 'a wrong pairing is not trusted even if the manifest said so');
  assert.equal(matchSource([{ ...YT, control: 'inventado' }], 'https://yt.example/abc', 'x').control, '');
});
