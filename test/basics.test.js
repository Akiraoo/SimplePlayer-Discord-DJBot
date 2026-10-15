import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { fmtTime, parseTime, clip } from '../src/util.js';
import { SimplePlayer } from '../src/simpleplayer.js';
import { resolve } from '../src/sources.js';

test('time helpers', () => {
  assert.equal(fmtTime(83), '1:23');
  assert.equal(fmtTime(3723), '1:02:03');
  assert.equal(parseTime('1:23'), 83);
  assert.equal(parseTime('83'), 83);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime('abc'), null);
  assert.equal(clip('abcdef', 4), 'abc…');
});

test('share links', () => {
  const p = SimplePlayer.parseShareLink;
  assert.deepEqual(p('https://simpleplayer.dpdns.org/s/abc123'), { kind: 'track', key: 'abc123' });
  assert.deepEqual(p('http://192.168.1.5:50000/share/x%20y'), { kind: 'track', key: 'x y' });
  assert.deepEqual(p('https://a.b/p/%E6%88%91%E7%9A%84%E6%AD%8C%E5%96%AE'), { kind: 'playlist', key: '我的歌單' });
  assert.deepEqual(p('https://a.b/c/k9'), { kind: 'custom', key: 'k9' });
  assert.equal(p('https://a.b/stream/abc'), null);
  assert.equal(p('just words'), null);
});

// a fake Simple Player server
function fakeServer() {
  const lib = {
    tracks: [
      { id: 't1', name: 'f1', title: 'Inertia - Acoustic', artist: 'AJR', album: 'The Maybe Man', duration: 230, hasCover: true },
      { id: 't2', name: 'f2', title: 'Inertia', artist: 'AJR', album: 'The Maybe Man', duration: 220, hasCover: false },
      { id: 't3', name: 'f3', title: '夜に駆ける', artist: 'YOASOBI', album: 'THE BOOK', duration: 261, hasCover: true },
    ],
  };
  const srv = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/library') return send(200, lib);
    if (req.url === '/api/config') return send(200, { publicOrigin: 'https://music.example.org' });
    if (req.url === '/api/playlists') return send(200, { AJR: ['t2', 't1', 'missing'] });
    if (req.url === '/api/custom-playlists/k9') return send(200, { id: 'k9', name: 'Mix', tracks: ['t3'] });
    if (req.url.startsWith('/api/custom-playlists/')) return send(404, { error: 'gone' });
    if (req.url === '/song.flac' && req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'audio/flac' });
      return res.end();
    }
    if (req.url === '/page' && req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end();
    }
    send(404, {});
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

test('resolve against a server', async () => {
  const srv = await fakeServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const sp = new SimplePlayer(base);
  try {
    let r = await resolve(sp, 'inertia');
    assert.equal(r.songs[0].title, 'Inertia', 'exact title ranks first');
    assert.equal(r.songs[0].input, `${base}/stream/t2`);
    assert.equal(r.songs[0].link, 'https://music.example.org/s/t2');

    r = await resolve(sp, 'https://music.example.org/s/t1');
    assert.equal(r.songs[0].title, 'Inertia - Acoustic');
    assert.equal(r.songs[0].cover, 'https://music.example.org/api/track/t1/cover');

    r = await resolve(sp, 'sp:t3');
    assert.equal(r.songs[0].artist, 'YOASOBI');

    r = await resolve(sp, 'https://whatever/p/AJR');
    assert.equal(r.songs.length, 2);
    assert.equal(r.label, 'AJR');

    r = await resolve(sp, `${base}/c/k9`);
    assert.equal(r.songs[0].title, '夜に駆ける');

    r = await resolve(sp, `${base}/c/old`);
    assert.match(r.error, /過期/);

    r = await resolve(sp, `${base}/song.flac`);
    assert.equal(r.songs[0].title, 'song');
    assert.equal(r.songs[0].input, `${base}/song.flac`);

    r = await resolve(sp, `${base}/page`);
    assert.match(r.error, /不是音訊檔/);

    r = await resolve(sp, 'nothing like this');
    assert.match(r.error, /找不到/);

    const hits = await sp.search('ajr maybe', 10);
    assert.equal(hits.length, 2);
  } finally {
    srv.close();
  }
});
