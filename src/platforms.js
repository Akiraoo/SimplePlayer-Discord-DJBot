// Music services that don't give out audio (Spotify, Apple Music, Deezer, KKBOX, TIDAL…):
// read the song names from the link, then each song is looked up on YouTube Music when it
// is about to play.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36';

/**
 * @typedef {object} MetaTrack
 * @property {string} title
 * @property {string} artist
 * @property {string} [album]
 * @property {number} duration seconds (0 = unknown)
 * @property {string|null} cover
 * @property {string|null} link
 */

async function get(url, type = 'text') {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8,ja;q=0.7' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return type === 'json' ? r.json() : r.text();
}

/** Short links (spotify.link, deezer.page.link, link.deezer.com…) → the real address. */
async function expand(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  });
  r.body?.cancel().catch(() => {});
  let final = r.url || url;
  // Deezer's short links land on a page with the real one in a query parameter
  try {
    const u = new URL(final);
    const dest = u.searchParams.get('dest') || u.searchParams.get('link');
    if (dest && /^https?:/i.test(dest)) final = dest;
  } catch {
    /* keep it */
  }
  return final;
}

/* ---------------- Spotify ---------------- */

/** open.spotify.com/(intl-xx/)track|album|playlist|artist/<id> → {type, id} */
export function parseSpotify(url) {
  const m = /open\.spotify\.com\/(?:intl-[\w-]+\/)?(?:embed\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+)/.exec(
    url,
  );
  if (m) return { type: m[1], id: m[2] };
  const u = /^spotify:(track|album|playlist|artist):([A-Za-z0-9]+)$/.exec(url);
  return u ? { type: u[1], id: u[2] } : null;
}

function joinArtists(list) {
  return (list || [])
    .map((a) => a?.name)
    .filter(Boolean)
    .join(', ');
}

function bestImage(sources) {
  const list = (sources || []).filter((s) => s?.url);
  if (!list.length) return null;
  return list.reduce((a, b) => ((a.width || 0) >= (b.width || 0) ? a : b)).url;
}

function spotifyLink(uri) {
  const m = /^spotify:(\w+):(\w+)$/.exec(uri || '');
  return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : null;
}

/** The data inside Spotify's embed page (the same page the "Embed" button gives you). */
export function parseSpotifyEmbed(html) {
  let entity = null;
  const next = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (next) {
    const data = JSON.parse(next[1]);
    entity = data?.props?.pageProps?.state?.data?.entity ?? null;
  }
  if (!entity) {
    // older layouts: base64 JSON in <script id="resource"> / <script id="initial-state">
    const b64 = /<script[^>]*id="(resource|initial-state)"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (b64) {
      const data = JSON.parse(Buffer.from(b64[2].trim(), 'base64').toString('utf8'));
      entity = b64[1] === 'initial-state' ? data?.data?.entity : data;
    }
  }
  if (!entity) throw new Error('讀不到 Spotify 頁面的資料（Spotify 可能改版了）');

  const cover = bestImage(entity.coverArt?.sources || entity.images || entity.visualIdentity?.image);
  const toTrack = (t, fallbackCover) => ({
    title: t.title || t.name || '',
    artist: joinArtists(t.artists) || t.subtitle || '',
    album: entity.type === 'album' ? entity.name || entity.title || '' : '',
    duration: Math.round((t.duration || 0) / 1000),
    cover: bestImage(t.coverArt?.sources || t.images) || fallbackCover,
    link: spotifyLink(t.uri),
  });
  const tracks = entity.trackList?.length
    ? entity.trackList.map((t) => toTrack(t, cover))
    : [toTrack(entity, cover)];
  return {
    label: entity.trackList?.length ? entity.name || entity.title || 'Spotify' : null,
    tracks: tracks.filter((t) => t.title),
  };
}

export async function spotify(url) {
  let ref = parseSpotify(url);
  if (!ref) ref = parseSpotify(await expand(url)); // spotify.link/…
  if (!ref) throw new Error('看不懂這個 Spotify 連結');
  const html = await get(`https://open.spotify.com/embed/${ref.type}/${ref.id}`);
  return parseSpotifyEmbed(html);
}

/* ---------------- Apple Music ---------------- */

/** music.apple.com/<cc>/album/<name>/<id>?i=<track> | /song/<name>/<id> | /album/<name>/<id> */
export function parseApple(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  const country = /^[a-z]{2}$/i.test(parts[0]) ? parts.shift() : 'us';
  const kind = parts[0];
  const id = parts[parts.length - 1];
  const track = u.searchParams.get('i');
  if (kind === 'album' && track) return { kind: 'song', id: track, country };
  if ((kind === 'song' || kind === 'album') && /^\d+$/.test(id)) return { kind, id, country };
  return { kind, id: null, country };
}

function itunesTrack(r) {
  return {
    title: r.trackName,
    artist: r.artistName || '',
    album: r.collectionName || '',
    duration: Math.round((r.trackTimeMillis || 0) / 1000),
    cover: r.artworkUrl100 ? r.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null,
    link: r.trackViewUrl ? r.trackViewUrl.replace(/[?&]uo=\d+/, '') : null,
  };
}

export async function apple(url) {
  const ref = parseApple(url);
  if (!ref.id) throw new Error('Apple Music 只支援單曲和專輯連結（播放清單讀不到曲目）');
  const q = ref.kind === 'album' ? '&entity=song' : '';
  const data = await get(`https://itunes.apple.com/lookup?id=${ref.id}&country=${ref.country}${q}`, 'json');
  const tracks = (data.results || []).filter((r) => r.wrapperType === 'track').map(itunesTrack);
  if (!tracks.length) throw new Error('Apple Music 找不到這個項目（可能是這個地區沒有上架）');
  const album = (data.results || []).find((r) => r.wrapperType === 'collection');
  return { label: ref.kind === 'album' ? album?.collectionName || 'Apple Music' : null, tracks };
}

/* ---------------- Deezer ---------------- */

export function parseDeezer(url) {
  const m = /deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)/.exec(url);
  return m ? { type: m[1], id: m[2] } : null;
}

function deezerTrack(t, album) {
  const al = t.album || album || {};
  return {
    title: t.title,
    artist: t.artist?.name || '',
    album: al.title || '',
    duration: t.duration || 0,
    cover: al.cover_xl || al.cover_big || null,
    link: t.link || null,
  };
}

export async function deezer(url) {
  let ref = parseDeezer(url);
  if (!ref) ref = parseDeezer(await expand(url)); // deezer.page.link / link.deezer.com
  if (!ref) throw new Error('看不懂這個 Deezer 連結');
  const data = await get(`https://api.deezer.com/${ref.type}/${ref.id}`, 'json');
  if (data.error) throw new Error(`Deezer：${data.error.message || '找不到'}`);
  if (ref.type === 'track') return { label: null, tracks: [deezerTrack(data)] };
  const tracks = (data.tracks?.data || []).map((t) => deezerTrack(t, ref.type === 'album' ? data : null));
  return { label: data.title || 'Deezer', tracks };
}

/* ---------------- anything else: the page's title ---------------- */

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function meta(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`,
    'i',
  );
  const m = re.exec(html);
  return m ? decodeEntities(m[1] ?? m[2]).trim() : '';
}

/** One song named by the page's og:title (KKBOX, TIDAL, Amazon Music, LINE MUSIC…). */
export async function pageTitle(url, service) {
  const html = await get(url);
  let title = meta(html, 'og:title') || decodeEntities(/<title>([^<]*)<\/title>/i.exec(html)?.[1] || '').trim();
  // drop the service's own name: "Song - Artist | TIDAL", "… - KKBOX"
  title = title.replace(/\s*[|\-–—]\s*(KKBOX|TIDAL|Amazon Music|LINE MUSIC|Apple Music|Spotify|Deezer)\s*$/i, '');
  if (!title) throw new Error(`讀不到這個 ${service} 連結的歌名`);
  const image = meta(html, 'og:image');
  return {
    label: null,
    tracks: [{ title, artist: '', duration: 0, cover: /^https:/.test(image) ? image : null, link: url }],
  };
}

/** Services handled here: [hostname test, name, reader]. */
export const SERVICES = [
  [/(^|\.)spotify\.com$|(^|\.)spotify\.link$/i, 'Spotify', spotify],
  [/(^|\.)music\.apple\.com$|^itunes\.apple\.com$/i, 'Apple Music', apple],
  [/(^|\.)deezer\.com$|^deezer\.page\.link$/i, 'Deezer', deezer],
  [/(^|\.)kkbox\.com$|^kkbox\.fm$/i, 'KKBOX', (u) => pageTitle(u, 'KKBOX')],
  [/(^|\.)tidal\.com$/i, 'TIDAL', (u) => pageTitle(u, 'TIDAL')],
  [/^music\.amazon\./i, 'Amazon Music', (u) => pageTitle(u, 'Amazon Music')],
  [/^music\.line\.me$/i, 'LINE MUSIC', (u) => pageTitle(u, 'LINE MUSIC')],
];
