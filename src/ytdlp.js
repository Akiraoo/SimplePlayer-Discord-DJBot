// Thin wrapper around the yt-dlp command line: YouTube, YouTube Music, SoundCloud,
// bilibili, Bandcamp, niconico and the other sites yt-dlp supports.

import { spawn } from 'node:child_process';

const NOT_INSTALLED =
  '找不到 yt-dlp：請先安裝（`winget install yt-dlp`），或在 `.env` 的 `YTDLP` 填 yt-dlp.exe 的路徑。';

export class YtDlp {
  /**
   * @param {{bin?: string, cookies?: string, extra?: string}} opts
   *   cookies: a cookies.txt (Netscape format) for age-restricted / members-only videos
   *   extra:   more yt-dlp arguments, separated by spaces
   */
  constructor({ bin, cookies, extra } = {}) {
    this.bin = bin || 'yt-dlp';
    this.cookies = cookies || '';
    this.extra = String(extra || '').split(/\s+/).filter(Boolean);
    // YouTube needs a JavaScript runtime; the Node.js running this bot works (yt-dlp
    // 2025.11+). Older yt-dlp versions don't know the option, so it is dropped on the fly.
    this.jsRuntime = `node:${process.execPath}`;
  }

  /** Arguments every call gets. */
  base() {
    const a = ['--no-warnings', '--no-progress', '--no-playlist'];
    if (this.jsRuntime) a.push('--js-runtimes', this.jsRuntime);
    if (this.cookies) a.push('--cookies', this.cookies);
    return [...a, ...this.extra];
  }

  /** [program, args] to start yt-dlp (a .js/.mjs "yt-dlp" runs on Node: the tests use one). */
  command(args) {
    const all = [...this.base(), ...args];
    return /\.m?js$/i.test(this.bin) ? [process.execPath, [this.bin, ...all]] : [this.bin, all];
  }

  /** Runs yt-dlp and returns stdout. */
  run(args, timeoutMs = 60_000) {
    return new Promise((ok, fail) => {
      const [file, argv] = this.command(args);
      const p = spawn(file, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      });
      const out = [];
      let err = '';
      p.stdout.on('data', (d) => out.push(d));
      p.stderr.on('data', (d) => {
        err = (err + d).slice(-4000);
      });
      const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.on('error', (e) => {
        clearTimeout(timer);
        fail(e.code === 'ENOENT' ? Object.assign(new Error(NOT_INSTALLED), { code: 'NO_YTDLP' }) : e);
      });
      p.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return ok(Buffer.concat(out).toString('utf8'));
        if (this.jsRuntime && /no such option: --js-runtimes/i.test(err)) {
          this.jsRuntime = null;
          console.warn('[yt-dlp] 版本太舊（不支援 --js-runtimes），YouTube 可能無法播放：請更新 yt-dlp（yt-dlp -U）');
          return this.run(args, timeoutMs).then(ok, fail);
        }
        if (signal) return fail(new Error('yt-dlp 逾時'));
        fail(new Error(errorLine(err) || `yt-dlp 結束代碼 ${code}`));
      });
    });
  }

  async json(args, timeoutMs) {
    const out = await this.run(['-J', ...args], timeoutMs);
    return JSON.parse(out);
  }

  /** What a link is: one video (full info, stream URL included) or a playlist (flat entries). */
  probe(url, max = 200) {
    return this.json(['--flat-playlist', '--playlist-end', String(max), '-f', 'bestaudio/best', '--', url]);
  }

  /** Full info for one page, with the stream URL of the best audio format. */
  info(url) {
    return this.json(['-f', 'bestaudio/best', '--', url]);
  }

  /**
   * Search one site: 'ytm' (YouTube Music "Songs"), 'yt', 'sc' (SoundCloud), 'bili' (bilibili).
   */
  async find(site, query, n = 10) {
    const target = {
      ytm: `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`,
      yt: `ytsearch${n}:${query}`,
      sc: `scsearch${n}:${query}`,
      bili: `bilisearch${n}:${query}`,
    }[site];
    if (!target) throw new Error(`不認得的搜尋來源 ${site}`);
    const r = await this.json(['--flat-playlist', '--playlist-end', String(n), '--', target]);
    return (r.entries || []).filter((e) => e && (e.url || e.id)).slice(0, n);
  }

  /**
   * Search. `music`: YouTube Music's "Songs" (official audio, no video intros) first,
   * then normal YouTube.
   */
  async search(query, n = 5, music = true) {
    if (music) {
      try {
        const hits = await this.find('ytm', query, n);
        if (hits.length) return hits;
      } catch (e) {
        if (e.code === 'NO_YTDLP') throw e;
        // fall back to YouTube
      }
    }
    return this.find('yt', query, n);
  }

  /** Command that writes the audio itself to stdout (when ffmpeg can't read the URL). */
  pipeCommand(url) {
    const [bin, args] = this.command(['-f', 'bestaudio/best', '-o', '-', '--', url]);
    return { bin, args };
  }
}

/** The useful part of yt-dlp's stderr: the last "ERROR:" line, without the prefix noise. */
export function errorLine(stderr) {
  const lines = String(stderr).split(/\r?\n/).filter((l) => l.trim());
  const e = lines.filter((l) => /^ERROR:/.test(l)).pop() || lines.pop() || '';
  return e
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '') // "[youtube] abc123: "
    .slice(0, 300);
}

/** Stream info from a full yt-dlp info dict (or null when it has no direct URL). */
export function streamOf(info) {
  if (!info?.url) return null;
  let expires = Date.now() + 20 * 60_000;
  try {
    const e = Number(new URL(info.url).searchParams.get('expire'));
    if (e > 0) expires = e * 1000 - 5 * 60_000;
  } catch {
    /* not a URL with an expiry */
  }
  return { input: info.url, headers: info.http_headers || null, expires };
}
