// /search: lists results from the library or a site, then the songs picked from the list
// (one, several or all) go into the queue. The list can be re-run on another source.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';

import { fromTrack, fromYt } from './sources.js';
import { clip, fmtTime } from './util.js';

const ACCENT = 0x2dd4bf;
const MAX = 10;
const TTL = 15 * 60_000; // Discord stops accepting clicks on a reply after 15 minutes anyway

export const SOURCES = {
  all: '曲庫＋YouTube Music',
  library: '曲庫',
  ytm: 'YouTube Music',
  yt: 'YouTube',
  sc: 'SoundCloud',
  bili: 'bilibili',
};
const TAG = { library: '曲庫', ytm: 'YTM', yt: 'YT', sc: 'SC', bili: 'B站' };

/** token → {userId, query, source, songs, errors, at} */
const searches = new Map();
let counter = 0;

function sweep() {
  const now = Date.now();
  for (const [k, v] of searches) if (now - v.at > TTL) searches.delete(k);
}

export function getSearch(token) {
  const s = searches.get(token);
  return s && Date.now() - s.at <= TTL ? s : null;
}

async function fromSource(sp, yt, source, query, n) {
  if (source === 'library') {
    const hits = await sp.search(query, n);
    return hits.map((t) => ({ ...fromTrack(sp, t), from: 'library' }));
  }
  const hits = await yt.find(source, query, n);
  return hits.map((e) => ({ ...fromYt(e), from: source }));
}

/** Runs a search and keeps it for the buttons. */
export async function runSearch(sp, yt, query, source, userId, token = null) {
  sweep();
  const errors = [];
  let songs = [];
  const parts = source === 'all' ? [['library', 5], ['ytm', MAX]] : [[source, MAX]];
  const results = await Promise.all(
    parts.map(([src, n]) =>
      fromSource(sp, yt, src, query, n).catch((e) => {
        errors.push(src === 'library' ? '曲庫：連不上 Simple Player 伺服器' : `${SOURCES[src]}：${e.message}`);
        return [];
      }),
    ),
  );
  for (const list of results) songs.push(...list);
  songs = songs.slice(0, MAX);
  const key = token ?? `${Date.now().toString(36)}${(counter++).toString(36)}`;
  const state = { userId, query, source, songs, errors, at: Date.now() };
  searches.set(key, state);
  return { token: key, state };
}

/** The result list with its picker and buttons. */
export function renderSearch(token, state) {
  const { songs, query, source, errors } = state;
  const lines = songs.map((s, i) => {
    const who = s.artist ? ` — ${clip(s.artist, 40)}` : '';
    const len = s.live ? ' `直播`' : s.duration ? ` \`${fmtTime(s.duration)}\`` : '';
    const title = s.link?.startsWith('https://') ? `[${clip(s.title, 70)}](${s.link})` : clip(s.title, 70);
    return `\`${String(i + 1).padStart(2)}.\` ${title}${who}${len}${source === 'all' ? ` · ${TAG[s.from]}` : ''}`;
  });
  if (!songs.length) lines.push('*沒有找到東西，換個關鍵字或來源試試。*');
  if (errors.length) lines.push('', ...errors.map((e) => `⚠ ${clip(e, 200)}`));
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(clip(`搜尋「${query}」`, 256))
    .setDescription(lines.join('\n'))
    .setFooter({ text: `來源：${SOURCES[source]} · 從選單挑一首或多首加入佇列` });

  const rows = [];
  if (songs.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`s:pick:${token}`)
          .setPlaceholder('選要加入的歌（可以多選）')
          .setMinValues(1)
          .setMaxValues(songs.length)
          .addOptions(
            songs.map((s, i) => ({
              label: clip(`${i + 1}. ${s.title}`, 100),
              description: clip([s.artist, s.duration ? fmtTime(s.duration) : '', TAG[s.from]].filter(Boolean).join(' · '), 100) || undefined,
              value: String(i),
            })),
          ),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`s:first:${token}`).setLabel('播第一個').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`s:firstnext:${token}`).setLabel('第一個插到下一首').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`s:all:${token}`).setLabel(`全部加入（${songs.length}）`).setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      ...['library', 'ytm', 'yt', 'sc', 'bili'].map((src) =>
        new ButtonBuilder()
          .setCustomId(`s:src:${token}:${src}`)
          .setLabel(SOURCES[src])
          .setStyle(src === source ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(src === source),
      ),
    ),
  );
  return { embeds: [embed], components: rows };
}
