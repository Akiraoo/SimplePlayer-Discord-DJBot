#!/usr/bin/env node
// Stands in for yt-dlp in tests: answers from canned data, logs its arguments.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_YTDLP_LOG) appendFileSync(process.env.FAKE_YTDLP_LOG, JSON.stringify(args) + '\n');
if (args.includes('--version')) {
  console.log('2026.08.19');
  process.exit(0);
}
const url = args[args.length - 1];
const out = (o) => {
  process.stdout.write(JSON.stringify(o));
  process.exit(0);
};
const video = (id, title, duration, extra = {}) => ({
  id,
  title,
  duration,
  webpage_url: `https://www.youtube.com/watch?v=${id}`,
  url: `https://rr1.googlevideo.com/videoplayback?id=${id}&expire=${Math.floor(Date.now() / 1000) + 21600}`,
  http_headers: { 'User-Agent': 'UA/1', Accept: '*/*' },
  formats: [{}],
  uploader: 'Some Channel',
  thumbnail: `https://i.ytimg.com/vi/${id}/hq.jpg`,
  ...extra,
});

if (url.startsWith('https://music.youtube.com/search')) {
  const q = new URL(url).searchParams.get('q');
  if (q.includes('nohit')) out({ _type: 'playlist', entries: [] });
  out({
    _type: 'playlist',
    entries: [
      { id: 'mv1', url: 'https://music.youtube.com/watch?v=mv1', title: `${q} (MV)`, duration: 320 },
      { id: 'au1', url: 'https://music.youtube.com/watch?v=au1', title: q, duration: 261 },
    ],
  });
}
if (url.startsWith('ytsearch')) {
  const q = url.replace(/^ytsearch\d*:/, '');
  if (q.includes('nohit')) out({ _type: 'playlist', entries: [] });
  out({ _type: 'playlist', entries: [{ id: 'yt1', url: 'https://www.youtube.com/watch?v=yt1', title: `YT ${q}` }] });
}
if (url.includes('list=PL1')) {
  out({
    _type: 'playlist',
    title: 'My List',
    entries: [
      { id: 'a', url: 'https://www.youtube.com/watch?v=a', title: 'A', duration: 100, channel: 'Artist - Topic' },
      { id: 'b', url: 'https://www.youtube.com/watch?v=b', title: '[Deleted video]' },
      { id: 'c', url: 'https://www.youtube.com/watch?v=c', title: 'C', duration: 200 },
    ],
  });
}
if (url.includes('soundcloud.com')) {
  out({ id: 'sc', title: 'SC song', duration: 180, webpage_url: url, url: 'https://cf-media.sndcdn.com/x.mp3', formats: [{}], uploader: 'scuser' });
}
const m = /[?&]v=([\w-]+)/.exec(url);
if (m) {
  if (m[1] === 'gone') {
    process.stderr.write('ERROR: [youtube] gone: Video unavailable. This video has been removed\n');
    process.exit(1);
  }
  out(video(m[1], `Video ${m[1]}`, 261, { artist: 'Real Artist', track: `Track ${m[1]}` }));
}
process.stderr.write(`ERROR: Unsupported URL: ${url}\n`);
process.exit(1);
