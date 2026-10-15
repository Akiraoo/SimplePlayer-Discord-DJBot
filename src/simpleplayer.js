// Client for the Simple Player Web Server (the same API the apps use).
// No Discord code here, so it can be tested on its own.

const LIBRARY_TTL_MS = 5 * 60 * 1000;

export class SimplePlayer {
  /**
   * @param {string} server  base URL the bot streams from, e.g. http://127.0.0.1:55555
   * @param {string} [publicOrigin]  public https address; empty = ask the server
   */
  constructor(server, publicOrigin = '') {
    this.server = String(server || '').trim().replace(/\/+$/, '');
    this.publicOrigin = String(publicOrigin || '').trim().replace(/\/+$/, '');
    this.library = [];
    this.byId = new Map();
    this.loadedAt = 0;
    this.loading = null;
  }

  async getJson(path) {
    const r = await fetch(this.server + path, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Simple Player 伺服器回應 HTTP ${r.status}（${path}）`);
    return r.json();
  }

  /** Library (cached for a few minutes). */
  async tracks(force = false) {
    if (!force && this.library.length && Date.now() - this.loadedAt < LIBRARY_TTL_MS) {
      return this.library;
    }
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const [lib, cfg] = await Promise.all([
            this.getJson('/api/library'),
            this.publicOrigin ? null : this.getJson('/api/config').catch(() => null),
          ]);
          if (cfg?.publicOrigin && !this.publicOrigin) {
            this.publicOrigin = String(cfg.publicOrigin).replace(/\/+$/, '');
          }
          this.library = (lib?.tracks || []).map((t) => ({
            id: String(t.id),
            title: t.title || t.name || String(t.id),
            artist: t.artist || '',
            album: t.album || '',
            duration: Number(t.duration) || 0,
            hasCover: !!t.hasCover,
          }));
          this.byId = new Map(this.library.map((t) => [t.id, t]));
          this.loadedAt = Date.now();
        } finally {
          this.loading = null;
        }
      })();
    }
    await this.loading;
    return this.library;
  }

  async track(id) {
    await this.tracks();
    let t = this.byId.get(id);
    if (!t) {
      await this.tracks(true); // a song added since the last refresh
      t = this.byId.get(id);
    }
    return t || null;
  }

  /** Searches title / artist / album; every word must match somewhere. */
  async search(query, limit = 25) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const lib = await this.tracks();
    const scored = [];
    for (const t of lib) {
      const title = t.title.toLowerCase();
      const hay = `${title} ${t.artist.toLowerCase()} ${t.album.toLowerCase()}`;
      if (!words.every((w) => hay.includes(w))) continue;
      const q = words.join(' ');
      const score = title === q ? 0 : title.startsWith(q) ? 1 : title.includes(q) ? 2 : 3;
      scored.push([score, t]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].title.localeCompare(b[1].title));
    return scored.slice(0, limit).map((x) => x[1]);
  }

  async playlist(name) {
    const all = await this.getJson('/api/playlists');
    const ids = Array.isArray(all?.[name]) ? all[name] : null;
    return ids ? { name, ids: ids.map(String) } : null;
  }

  async customPlaylist(id) {
    try {
      const v = await this.getJson(`/api/custom-playlists/${encodeURIComponent(id)}`);
      return v?.tracks ? { name: v.name || id, ids: v.tracks.map(String) } : null;
    } catch {
      return null;
    }
  }

  streamUrl(id) {
    return `${this.server}/stream/${encodeURIComponent(id)}`;
  }

  /** Cover for Discord embeds: only a public https address works there. */
  coverUrl(t) {
    if (!t?.hasCover || !this.publicOrigin.startsWith('https://')) return null;
    return `${this.publicOrigin}/api/track/${encodeURIComponent(t.id)}/cover`;
  }

  shareUrl(id) {
    return this.publicOrigin ? `${this.publicOrigin}/s/${encodeURIComponent(id)}` : null;
  }

  /**
   * Recognises Simple Player share links: /s/<id> (also /share/, /play/), /p/<playlist>,
   * /c/<custom playlist>. Any host is accepted when the path has that shape and the id
   * exists, so LAN and public addresses both work.
   * @returns {{kind:'track'|'playlist'|'custom', key:string}|null}
   */
  static parseShareLink(text) {
    let u;
    try {
      u = new URL(String(text).trim());
    } catch {
      return null;
    }
    if (!/^https?:$/.test(u.protocol)) return null;
    const m = u.pathname.match(/^\/(s|share|play|p|c)\/([^/]+)\/?$/);
    if (!m) return null;
    const key = decodeURIComponent(m[2]);
    const kind = m[1] === 'p' ? 'playlist' : m[1] === 'c' ? 'custom' : 'track';
    return { kind, key };
  }
}
