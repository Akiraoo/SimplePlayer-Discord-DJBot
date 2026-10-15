// One player per Discord server: a queue, the voice connection and an ffmpeg process that
// turns the current song into PCM for @discordjs/voice.

import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';

import { errorLine } from './ytdlp.js';

const BUFFER_BYTES = 48_000 * 2 * 2 * 10; // 10 s of 48 kHz stereo s16

let nextQid = 1;
/** Gives each queued song a stable id (the queue editor picks songs by it). */
function tag(songs) {
  for (const s of songs) s.qid = nextQid++;
}

export class GuildPlayer {
  /**
   * @param {string} guildId
   * @param {{ffmpeg: string, volume: number,
   *          prepare: (song: object, opts?: {pipe?: boolean}) => Promise<{input?: string,
   *            headers?: object|null, pipe?: {bin: string, args: string[]}}>,
   *          onNowPlaying: (gp: GuildPlayer) => void,
   *          onEmpty: (gp: GuildPlayer) => void, onError: (gp: GuildPlayer, msg: string) => void}} opts
   */
  constructor(guildId, opts) {
    this.guildId = guildId;
    this.opts = opts;
    /** @type {import('./sources.js').Song[]} */
    this.queue = [];
    /** @type {(import('./sources.js').Song & {requester?: string})|null} */
    this.current = null;
    this.loop = 'off'; // 'off' | 'track' | 'queue'
    this.volume = opts.volume;
    this.connection = null;
    this.channelId = null;
    this.textChannel = null;
    this.ffmpeg = null;
    this.feeder = null; // yt-dlp writing audio into ffmpeg (pipe mode)
    this.buffer = null; // read-ahead between ffmpeg and Discord
    this.ffDone = null; // resolves with {code, err} when the current ffmpeg exits
    this.resource = null;
    this.token = 0; // bumped whenever what should be playing changes
    this.preparing = false;
    this.seekOffset = 0;
    this.idleSince = Date.now();
    this.skipping = false;

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.player.on('stateChange', (oldState, newState) => {
      // only the end of the song that is current now moves on (not a replaced one after a seek)
      if (
        newState.status === AudioPlayerStatus.Idle &&
        oldState.status !== AudioPlayerStatus.Idle &&
        oldState.resource === this.resource
      ) {
        this.#ended(oldState.resource).catch((e) => console.error(`[${this.guildId}]`, e));
      }
    });
    this.player.on('error', (err) => {
      console.error(`[${this.guildId}] audio error:`, err.message);
      this.opts.onError(this, `播放出錯：${err.message}`);
    });
  }

  get connected() {
    return !!this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed;
  }

  /** Joins (or moves to) a voice channel. */
  async connect(channel) {
    if (this.connected && this.channelId === channel.id) return;
    if (this.connected) this.connection.destroy();
    const conn = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    this.connection = conn;
    this.channelId = channel.id;
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // moved to another channel, or a short network hiccup: Discord reconnects by itself
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        // kicked or the channel is gone
        if (this.connection === conn) this.stop();
      }
    });
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    } catch (e) {
      conn.destroy();
      this.connection = null;
      throw new Error('連不上語音頻道（20 秒逾時）。');
    }
    conn.subscribe(this.player);
  }

  /** Adds songs; starts playing when nothing is. Returns the queue position of the first. */
  enqueue(songs) {
    tag(songs);
    const pos = this.queue.length + (this.current ? 1 : 0);
    this.queue.push(...songs);
    if (!this.current) this.next();
    return pos;
  }

  /** Plays queue[i] now (the rest of the queue stays). */
  jump(i) {
    const [song] = this.queue.splice(i, 1);
    if (!song) return false;
    this.queue.unshift(song);
    if (this.current) this.skip();
    else this.next();
    return true;
  }

  /** Puts songs right after the current one. */
  playNext(songs) {
    if (!this.current) return this.enqueue(songs);
    tag(songs);
    this.queue.unshift(...songs);
    return 1;
  }

  /** Moves on after a song ends (or is skipped). */
  next() {
    const prev = this.current;
    const skipped = this.skipping;
    this.skipping = false;
    if (prev && this.loop === 'track' && !skipped && !prev.failed) {
      this.#play(prev, 0);
      return;
    }
    if (prev && this.loop === 'queue' && !prev.failed) this.queue.push(prev);
    const song = this.queue.shift() || null;
    this.current = song;
    if (!song) {
      this.token++;
      this.preparing = false;
      this.#kill();
      this.resource = null;
      this.idleSince = Date.now();
      this.opts.onEmpty(this);
      return;
    }
    this.#play(song, 0);
  }

  skip() {
    if (!this.current) return false;
    this.skipping = true;
    if (this.preparing || this.player.state.status === AudioPlayerStatus.Idle) this.next();
    else this.player.stop(true); // → Idle → next()
    return true;
  }

  /** Clears everything and leaves the channel. */
  stop() {
    this.token++;
    this.preparing = false;
    this.queue = [];
    this.current = null;
    this.resource = null;
    this.player.stop(true);
    this.#kill();
    if (this.connected) this.connection.destroy();
    this.connection = null;
    this.channelId = null;
    this.idleSince = Date.now();
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  get paused() {
    return this.player.state.status === AudioPlayerStatus.Paused ||
      this.player.state.status === AudioPlayerStatus.AutoPaused;
  }

  seek(seconds) {
    if (!this.current || this.preparing || this.current.live) return false;
    this.#play(this.current, Math.max(0, seconds), true);
    return true;
  }

  setVolume(percent) {
    this.volume = Math.max(0, Math.min(150, percent));
    this.resource?.volume?.setVolume(this.volume / 100);
  }

  /** Seconds into the current song. */
  get position() {
    if (!this.resource) return 0;
    return this.seekOffset + this.resource.playbackDuration / 1000;
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  #kill() {
    if (this.buffer) {
      this.buffer.destroy();
      this.buffer = null;
    }
    if (this.feeder) {
      this.feeder.stdout?.destroy();
      this.feeder.kill('SIGKILL');
      this.feeder = null;
    }
    if (this.ffmpeg) {
      this.ffmpeg.stdout?.destroy();
      this.ffmpeg.kill('SIGKILL');
      this.ffmpeg = null;
    }
  }

  #play(song, at, seeking = false, pipe = false) {
    this.#start(song, at, seeking, pipe).catch((e) => {
      console.error(`[${this.guildId}] start failed:`, e);
    });
  }

  /** A song ran out. Right away with an ffmpeg error = it couldn't be read. */
  async #ended(resource) {
    const song = this.current;
    const token = this.token;
    if (song && !this.skipping && resource.playbackDuration < 2000 && this.ffDone) {
      const r = await Promise.race([this.ffDone, new Promise((ok) => setTimeout(ok, 3000, null))]);
      if (token !== this.token) return;
      if (r && (r.code || r.err)) {
        if (song.page && !song._piped) {
          // ffmpeg couldn't read the link yt-dlp gave: let yt-dlp download it instead
          song._piped = true;
          console.warn(`[${this.guildId}] ${song.title}: 改用 yt-dlp 下載（${r.err || r.code}）`);
          this.#play(song, this.seekOffset, true, true);
          return;
        }
        song.failed = true;
        this.opts.onError(this, `無法播放 **${song.title}**：${r.err || `ffmpeg 結束代碼 ${r.code}`}`);
      }
    }
    this.next();
  }

  async #start(song, at, seeking = false, pipe = false) {
    const token = ++this.token;
    this.#kill();
    let src;
    this.preparing = true;
    try {
      src = await this.opts.prepare(song, { pipe: pipe || !!song._piped });
    } catch (e) {
      if (token !== this.token) return;
      this.preparing = false;
      song.failed = true;
      this.opts.onError(this, `無法播放 **${song.title}**：${e.message}`);
      this.skipping = true; // don't replay it with loop on
      this.next();
      return;
    }
    if (token !== this.token) return; // skipped / stopped while looking it up
    this.preparing = false;

    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    let feeder = null;
    let feederErr = '';
    if (src.pipe) {
      feeder = spawn(src.pipe.bin, src.pipe.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      feeder.on('error', () => {});
      feeder.stderr.on('data', (d) => {
        feederErr = (feederErr + d).slice(-2000);
      });
      if (at > 0) args.push('-ss', at.toFixed(3));
      args.push('-i', 'pipe:0');
    } else {
      if (/^https?:/i.test(src.input)) {
        // streams over the network: ride out short drops
        args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
        const h = { ...(src.headers || {}) };
        const ua = h['User-Agent'];
        delete h['User-Agent'];
        if (ua) args.push('-user_agent', ua);
        const rest = Object.entries(h)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join('');
        if (rest) args.push('-headers', rest);
      }
      if (at > 0) args.push('-ss', at.toFixed(3));
      args.push('-i', src.input);
    }
    args.push('-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');
    const ff = spawn(this.opts.ffmpeg, args, {
      stdio: [feeder ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (feeder) {
      feeder.stdout.pipe(ff.stdin);
      ff.stdin.on('error', () => {}); // ffmpeg quit first (skip / seek)
    }
    let err = '';
    ff.stderr.on('data', (d) => {
      err = (err + d).slice(-500);
    });
    ff.on('error', (e) => {
      this.opts.onError(this, `無法啟動 ffmpeg：${e.message}`);
    });
    this.ffDone = new Promise((ok) => {
      ff.on('close', (code) => {
        // in pipe mode, yt-dlp's complaint says more than ffmpeg's "invalid data"
        const msg = (/ERROR:/.test(feederErr) && errorLine(feederErr)) || err.trim().split(/\r?\n/).pop() || '';
        if (code && code !== 255 && ff === this.ffmpeg && msg) console.error(`[${this.guildId}] ffmpeg:`, err.trim());
        ok({ code: code === 255 ? 0 : code, err: code && code !== 255 ? msg : '' });
      });
    });
    this.ffmpeg = ff;
    this.feeder = feeder;
    // ~10 s of PCM read ahead, so a Wi-Fi or network hiccup doesn't cut the sound
    const buffer = new PassThrough({ highWaterMark: BUFFER_BYTES });
    ff.stdout.pipe(buffer);
    ff.stdout.on('error', () => {});
    buffer.on('error', () => {});
    this.buffer = buffer;
    const resource = createAudioResource(buffer, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });
    resource.volume.setVolume(this.volume / 100);
    this.resource = resource;
    this.seekOffset = at;
    this.player.play(resource);
    if (!seeking) {
      this.opts.onNowPlaying(this);
      // look the next one up now, so it starts without a pause
      const next = this.queue[0];
      if (next) this.opts.prepare(next).catch(() => {});
    }
  }
}
