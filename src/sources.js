// Turns what someone typed into /play into songs the player can stream: Simple Player
// share links and library search, direct audio URLs, sites yt-dlp can read (YouTube,
// SoundCloud, bilibili…) and music services whose songs are found on YouTube Music.

import { SERVICES } from './platforms.js';
import { SimplePlayer } from './simpleplayer.js';
import { streamOf } from './ytdlp.js';

const AUDIO_EXT = /\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|webm|mka|aiff?|alac|wv|ape)(\?|#|$)/i;

/**
 * @typedef {object} Song
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {number} duration   seconds (0 = unknown)
 * @property {string} input      what ffmpeg reads
 * @property {string|null} cover public image URL for embeds
 * @property {string|null} link  page to open
 * @property {string} source     'simpleplayer' | 'url' | 'ytdlp' (a page yt-dlp reads) |
 *                               'lazy' (found on YouTube Music when it is about to play)
 * @property {string} [page]     yt-dlp: the page URL
 * @property {string} [query]    lazy: what to search for
 * @property {boolean} [live]
 */

export const MAX_LIST = Math.max(1, Number(process.env.MAX_PLAYLIST) || 200);

const DEAD = /^\[(private|deleted|unavailable) video\]$/i;

function cleanArtist(a) {
  return String(a || '').replace(/\s*-\s*Topic$/i, '');
}

function thumb(e) {
  if (typeof e.thumbnail === 'string' && e.thumbnail.startsWith('https://')) return e.thumbnail;
  const list = (e.thumbnails || []).filter((t) => t?.url?.startsWith('https://'));
  return list.length ? list[list.length - 1].url : null;
}

/** A yt-dlp entry (flat playlist entry, search hit or full info) → Song. */
export function fromYt(e) {
  const page = e.webpage_url || e.url || (e.id && `https://www.youtube.com/watch?v=${e.id}`);
  const song = {
    title: e.track || e.title || page,
    artist: cleanArtist(e.artist || e.artists?.join?.(', ') || e.creator || e.uploader || e.channel),
    album: e.album || '',
    duration: Math.round(e.duration || 0),
    input: null,
    cover: thumb(e),
    link: /^https:/.test(page) ? page : null,
    source: 'ytdlp',
    page,
    live: !!e.is_live,
  };
  if (Array.isArray(e.formats)) {
    // full info: the stream URL is already here
    const st = streamOf(e);
    if (st) song._stream = st;
  }
  return song;
}

/** A song from another service's metadata, to be found on YouTube Music later. */
function fromMeta(t, service) {
  return {
    title: t.title,
    artist: t.artist || '',
    album: t.album || '',
    duration: t.duration || 0,
    input: null,
    cover: t.cover || null,
    link: t.link || null,
    source: 'lazy',
    service,
    query: [t.title, t.artist].filter(Boolean).join(' '),
  };
}

/** Picks the search hit whose length matches best (when the length is known). */
export function pickBest(hits, duration) {
  if (!hits.length) return null;
  if (!duration) return hits[0];
  const close = hits.find((h) => h.duration && Math.abs(h.duration - duration) <= 8);
  if (close) return close;
  const timed = hits.filter((h) => h.duration);
  if (!timed.length) return hits[0];
  const best = timed.reduce((a, b) => (Math.abs(a.duration - duration) <= Math.abs(b.duration - duration) ? a : b));
  return Math.abs(best.duration - duration) <= 30 ? best : hits[0];
}

/**
 * What ffmpeg should read for a song: {input, headers?, pipe?}. Songs from yt-dlp and
 * other services are looked up here (just before playing, so their links don't expire
 * in the queue).
 */
export function prepare(yt, song, { pipe = false } = {}) {
  if (song.source !== 'ytdlp' && song.source !== 'lazy') return Promise.resolve({ input: song.input });
  if (!pipe && song._stream && song._stream.expires > Date.now()) return Promise.resolve(song._stream);
  if (song._pending) return song._pending;
  song._pending = (async () => {
    if (!song.page) {
      const hits = await yt.search(song.query, 5);
      const best = pickBest(hits, song.duration);
      if (!best) throw new Error(`YouTube Music 上找不到「${song.query}」`);
      song.page = best.webpage_url || best.url || `https://www.youtube.com/watch?v=${best.id}`;
      song.matched = best.title || null;
    }
    if (pipe) return { pipe: yt.pipeCommand(song.page) };
    const info = await yt.info(song.page);
    const full = fromYt(info);
    if (song.source === 'ytdlp') {
      // flat playlist entries can be thin (SoundCloud has no titles there)
      if (!song.title || song.title === song.page) song.title = full.title;
      song.artist ||= full.artist;
      song.album ||= full.album;
      song.cover ||= full.cover;
      song.live = full.live;
    }
    song.duration ||= full.duration;
    if (!full._stream) return { pipe: yt.pipeCommand(song.page) };
    song._stream = full._stream;
    return full._stream;
  })().finally(() => {
    song._pending = null;
  });
  return song._pending;
}

async function fromYtdlp(yt, url) {
  const info = await yt.probe(url, MAX_LIST);
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    const songs = (info.entries || [])
      .filter((e) => e && (e.url || e.id) && !DEAD.test(e.title || '') && e.ie_key !== 'YoutubeTab')
      .slice(0, MAX_LIST)
      .map(fromYt);
    return songs.length
      ? { songs, label: info.title || '播放清單' }
      : { songs: [], error: '這個連結裡沒有可以播放的內容。' };
  }
  return { songs: [fromYt(info)] };
}

async function searchYt(yt, query, music) {
  const hits = await yt.search(query, 1, music);
  return hits.length
    ? { songs: [fromYt(hits[0])] }
    : { songs: [], error: `YouTube${music ? ' Music' : ''} 上找不到「${query}」。` };
}

export function fromTrack(sp, t) {
  return {
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    input: sp.streamUrl(t.id),
    cover: sp.coverUrl(t),
    link: sp.shareUrl(t.id),
    source: 'simpleplayer',
  };
}

async function fromIds(sp, ids) {
  const out = [];
  for (const id of ids) {
    const t = await sp.track(id);
    if (t) out.push(fromTrack(sp, t));
  }
  return out;
}

async function looksLikeAudio(url) {
  if (AUDIO_EXT.test(new URL(url).pathname)) return true;
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const type = r.headers.get('content-type') || '';
    return r.ok && /^(audio\/|application\/ogg)/i.test(type);
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{songs: Song[], label?: string, error?: string}>}
 *   `label` describes what was added when it is more than one song (a playlist name).
 */
export async function resolve(sp, input, yt = null) {
  const text = String(input ?? '').trim();
  if (!text) return { songs: [], error: '請輸入連結或歌名。' };

  // picked from the autocomplete list
  if (text.startsWith('sp:')) {
    const t = await sp.track(text.slice(3));
    return t ? { songs: [fromTrack(sp, t)] } : { songs: [], error: '找不到這首歌，可能已從伺服器移除。' };
  }

  // picked from the autocomplete list: search YouTube Music / YouTube
  if (/^ytm?:/.test(text)) {
    if (!yt) return { songs: [], error: '沒有設定 yt-dlp。' };
    const q = text.replace(/^ytm?:/, '').trim();
    return q ? searchYt(yt, q, text.startsWith('ytm:')) : { songs: [], error: '請輸入要搜尋的歌名。' };
  }

  const share = SimplePlayer.parseShareLink(text);
  if (share) {
    if (share.kind === 'track') {
      const t = await sp.track(share.key);
      if (t) return { songs: [fromTrack(sp, t)] };
      // not ours: maybe a direct audio link that happens to look similar
    } else {
      const list =
        share.kind === 'playlist' ? await sp.playlist(share.key) : await sp.customPlaylist(share.key);
      if (!list) {
        return {
          songs: [],
          error: share.kind === 'custom' ? '這個自訂播放清單不存在或已過期。' : '找不到這個播放清單。',
        };
      }
      const songs = await fromIds(sp, list.ids);
      return songs.length
        ? { songs, label: list.name }
        : { songs: [], error: '這個播放清單裡沒有可以播放的歌。' };
    }
  }

  let url = null;
  try {
    url = new URL(text);
  } catch {
    /* plain text: search */
  }
  if (url && /^https?:$/.test(url.protocol)) {
    const service = SERVICES.find(([re]) => re.test(url.hostname));
    if (service) {
      const [, name, read] = service;
      let meta;
      try {
        meta = await read(text);
      } catch (e) {
        return { songs: [], error: `讀不到這個 ${name} 連結：${e.message}` };
      }
      const songs = meta.tracks.slice(0, MAX_LIST).map((t) => fromMeta(t, name));
      if (!songs.length) return { songs: [], error: `這個 ${name} 連結裡沒有歌。` };
      return { songs, label: meta.label || undefined, via: name };
    }
    if (await looksLikeAudio(text)) {
      const name = decodeURIComponent(url.pathname.split('/').pop() || url.hostname);
      return {
        songs: [
          {
            title: name.replace(/\.[^.]+$/, '') || name,
            artist: url.hostname,
            album: '',
            duration: 0,
            input: text,
            cover: null,
            link: text,
            source: 'url',
          },
        ],
      };
    }
    if (!yt) return { songs: [], error: '這個連結看起來不是音訊檔，也不是 Simple Player 的分享連結。' };
    try {
      return await fromYtdlp(yt, text);
    } catch (e) {
      if (e.code === 'NO_YTDLP') return { songs: [], error: e.message };
      return { songs: [], error: `讀不到這個連結：${e.message}` };
    }
  }

  // plain text: the library first (our own files), then YouTube Music
  let hits = [];
  let libraryDown = false;
  try {
    hits = await sp.search(text, 1);
  } catch {
    libraryDown = !!yt; // the Simple Player server is off: look on the web instead
    if (!yt) throw new Error('連不上 Simple Player 伺服器');
  }
  if (hits.length) return { songs: [fromTrack(sp, hits[0])] };
  if (!yt) return { songs: [], error: `曲庫裡找不到「${text}」。` };
  try {
    const r = await searchYt(yt, text, true);
    if (r.songs.length) r.fromWeb = libraryDown ? 'down' : true;
    return r;
  } catch (e) {
    return { songs: [], error: `曲庫裡找不到「${text}」，YouTube 搜尋也失敗：${e.message}` };
  }
}
