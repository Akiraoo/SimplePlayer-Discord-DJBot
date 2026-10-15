import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { parseApple, parseDeezer, parseSpotify, parseSpotifyEmbed } from '../src/platforms.js';
import { SimplePlayer } from '../src/simpleplayer.js';
import { fromYt, pickBest, prepare, resolve } from '../src/sources.js';
import { YtDlp, errorLine, streamOf } from '../src/ytdlp.js';

const fake = fileURLToPath(new URL('./fixtures/fake-yt-dlp.mjs', import.meta.url));
const yt = new YtDlp({ bin: fake });
// a Simple Player server that has nothing (and isn't there): library search finds nothing
const sp = new SimplePlayer('http://127.0.0.1:9');
sp.search = async () => [];

test('link parsers', () => {
  assert.deepEqual(parseSpotify('https://open.spotify.com/intl-ja/track/4cOdK2wGLETKBW3PvgPWqT?si=x'), {
    type: 'track',
    id: '4cOdK2wGLETKBW3PvgPWqT',
  });
  assert.deepEqual(parseSpotify('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), {
    type: 'playlist',
    id: '37i9dQZF1DXcBWIGoYBM5M',
  });
  assert.deepEqual(parseApple('https://music.apple.com/tw/album/the-book/1544463513?i=1544463514'), {
    kind: 'song',
    id: '1544463514',
    country: 'tw',
  });
  assert.deepEqual(parseApple('https://music.apple.com/jp/album/the-book/1544463513'), {
    kind: 'album',
    id: '1544463513',
    country: 'jp',
  });
  assert.equal(parseApple('https://music.apple.com/tw/playlist/x/pl.abc').id, null);
  assert.deepEqual(parseDeezer('https://www.deezer.com/fr/album/302127'), { type: 'album', id: '302127' });
});

test('spotify embed page', () => {
  const entity = {
    type: 'playlist',
    name: 'Mix',
    coverArt: { sources: [{ url: 'https://i.scdn.co/small', width: 64 }, { url: 'https://i.scdn.co/big', width: 640 }] },
    trackList: [
      { uri: 'spotify:track:aaa', title: '夜に駆ける', subtitle: 'YOASOBI', duration: 261000 },
      { uri: 'spotify:track:bbb', title: 'Inertia', artists: [{ name: 'AJR' }], duration: 220500 },
    ],
  };
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { state: { data: { entity } } } },
  })}</script></body></html>`;
  const r = parseSpotifyEmbed(html);
  assert.equal(r.label, 'Mix');
  assert.equal(r.tracks.length, 2);
  assert.deepEqual(r.tracks[0], {
    title: '夜に駆ける',
    artist: 'YOASOBI',
    album: '',
    duration: 261,
    cover: 'https://i.scdn.co/big',
    link: 'https://open.spotify.com/track/aaa',
  });
  assert.equal(r.tracks[1].artist, 'AJR');

  const single = { type: 'track', name: 'Song', title: 'Song', artists: [{ name: 'X' }, { name: 'Y' }], duration: 1000 };
  const html2 = `<script id="resource" type="text/plain">${Buffer.from(JSON.stringify(single)).toString('base64')}</script>`;
  const r2 = parseSpotifyEmbed(html2);
  assert.equal(r2.label, null);
  assert.equal(r2.tracks[0].artist, 'X, Y');
  assert.throws(() => parseSpotifyEmbed('<html></html>'), /Spotify/);
});

test('helpers', () => {
  assert.equal(errorLine('WARNING: x\nERROR: [youtube] abc: Video unavailable\n'), 'Video unavailable');
  const st = streamOf({ url: 'https://a/videoplayback?expire=2000000000', http_headers: { A: 'b' } });
  assert.equal(st.expires, 2000000000 * 1000 - 300000);
  const hits = [
    { title: 'MV', duration: 320 },
    { title: 'audio', duration: 263 },
  ];
  assert.equal(pickBest(hits, 261).title, 'audio');
  assert.equal(pickBest(hits, 0).title, 'MV');
  assert.equal(pickBest(hits, 30).title, 'MV', 'nothing close: the top hit');
  const s = fromYt({ id: 'q', url: 'https://www.youtube.com/watch?v=q', title: 'T', channel: 'Band - Topic' });
  assert.equal(s.artist, 'Band');
  assert.equal(s._stream, undefined, 'flat entries have no stream URL');
});

test('yt-dlp links, searches and lazy songs', async () => {
  let r = await resolve(sp, 'https://www.youtube.com/watch?v=abc', yt);
  assert.equal(r.songs.length, 1);
  const v = r.songs[0];
  assert.equal(v.title, 'Track abc');
  assert.equal(v.artist, 'Real Artist');
  assert.equal(v.link, 'https://www.youtube.com/watch?v=abc');
  assert.ok(v._stream.input.includes('googlevideo'), 'the stream URL comes with the probe');
  let st = await prepare(yt, v);
  assert.equal(st.headers['User-Agent'], 'UA/1');

  r = await resolve(sp, 'https://www.youtube.com/playlist?list=PL1', yt);
  assert.equal(r.label, 'My List');
  assert.deepEqual(r.songs.map((s) => s.title), ['A', 'C'], 'deleted videos are left out');
  assert.equal(r.songs[0].artist, 'Artist');
  st = await prepare(yt, r.songs[0]);
  assert.ok(st.input.includes('id=a'));
  assert.equal(r.songs[0].title, 'A', 'keeps the playlist title');

  r = await resolve(sp, 'https://soundcloud.com/u/t', yt);
  assert.equal(r.songs[0].title, 'SC song');

  r = await resolve(sp, 'https://www.youtube.com/watch?v=gone', yt);
  assert.match(r.error, /Video unavailable/);

  // plain text with no library hit: YouTube Music, the hit whose length is closest
  // (only one hit is asked for here, so it's the first)
  r = await resolve(sp, '夜に駆ける', yt);
  assert.equal(r.fromWeb, true);
  assert.equal(r.songs[0].page, 'https://music.youtube.com/watch?v=mv1');

  r = await resolve(sp, 'yt:something', yt);
  assert.equal(r.songs[0].title, 'YT something');

  r = await resolve(sp, 'ytm:nohit', yt);
  assert.match(r.error, /找不到/);

  // a song known only by name (Spotify…): looked up when it plays, matched by length
  const lazy = { title: '夜に駆ける', artist: 'YOASOBI', duration: 261, source: 'lazy', query: '夜に駆ける YOASOBI' };
  st = await prepare(yt, lazy);
  assert.equal(lazy.page, 'https://music.youtube.com/watch?v=au1');
  assert.ok(st.input.includes('id=au1'));
  assert.equal(lazy.title, '夜に駆ける', 'keeps the Spotify title');

  const pipe = await prepare(yt, lazy, { pipe: true });
  assert.equal(pipe.pipe.bin, process.execPath);
  assert.equal(pipe.pipe.args[0], fake);
  assert.deepEqual(pipe.pipe.args.slice(-4), ['-o', '-', '--', 'https://music.youtube.com/watch?v=au1']);
  assert.ok(pipe.pipe.args.includes('--js-runtimes'));

  await assert.rejects(prepare(yt, { title: 'x', source: 'lazy', query: 'nohit at all' }), /找不到/);

  const missing = new YtDlp({ bin: '/nonexistent/yt-dlp' });
  r = await resolve(sp, 'https://www.youtube.com/watch?v=abc', missing);
  assert.match(r.error, /yt-dlp/);
});
