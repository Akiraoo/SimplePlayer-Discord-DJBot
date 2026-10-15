// Interactive queue editor: /queue shows a page of the queue with a song picker and
// buttons to move, remove, play now, shuffle and clear.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';

import { clip, fmtTime } from './util.js';

const PAGE = 10;
const ACCENT = 0x2dd4bf;

/** Per message: which page is shown and which song is picked (by object, so it survives
 * the queue moving on underneath). */
const panels = new Map();

export function panelState(messageId) {
  let s = panels.get(messageId);
  if (!s) {
    s = { page: 0, sel: null };
    panels.set(messageId, s);
    if (panels.size > 100) panels.delete(panels.keys().next().value);
  }
  return s;
}

function line(s, n, picked) {
  const who = s.artist ? ` — ${clip(s.artist, 40)}` : '';
  const len = s.duration ? ` \`${fmtTime(s.duration)}\`` : '';
  const text = `\`${String(n).padStart(2)}.\` ${clip(s.title, 70)}${who}${len}`;
  return picked ? `▸ **${text}**` : text;
}

/** Message content for the panel. */
export function renderQueue(gp, state = { page: 0, sel: null }) {
  const q = gp.queue;
  const pages = Math.max(1, Math.ceil(q.length / PAGE));
  state.page = Math.min(Math.max(0, state.page), pages - 1);
  if (state.sel && !q.includes(state.sel)) state.sel = null;
  const start = state.page * PAGE;
  const slice = q.slice(start, start + PAGE);

  const lines = [];
  if (gp.current) {
    lines.push(`**正在播放**　${clip(gp.current.title, 70)}${gp.current.artist ? ` — ${clip(gp.current.artist, 40)}` : ''}`);
    lines.push('');
  }
  if (!q.length) lines.push('*佇列是空的，用 `/play` 加歌。*');
  slice.forEach((s, i) => lines.push(line(s, start + i + 1, s === state.sel)));
  const total = q.reduce((a, s) => a + (s.duration || 0), 0);
  const loop = gp.loop !== 'off' ? ` · 循環：${gp.loop === 'track' ? '單曲' : '佇列'}` : '';
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle('佇列')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${q.length} 首 · ${fmtTime(total)} · 第 ${state.page + 1}/${pages} 頁${loop}` });

  const rows = [];
  if (slice.length) {
    const sel = q.indexOf(state.sel);
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('q:pick')
          .setPlaceholder('選一首歌來編輯')
          .addOptions(
            slice.map((s, i) => ({
              label: clip(`${start + i + 1}. ${s.title}`, 100),
              description: s.artist ? clip(s.artist, 100) : undefined,
              value: String(s.qid ?? start + i),
              default: start + i === sel,
            })),
          ),
      ),
    );
  }
  const none = !state.sel;
  const at = q.indexOf(state.sel);
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('q:up').setLabel('上移').setStyle(ButtonStyle.Secondary).setDisabled(none || at <= 0),
      new ButtonBuilder()
        .setCustomId('q:down')
        .setLabel('下移')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(none || at >= q.length - 1),
      new ButtonBuilder().setCustomId('q:top').setLabel('移到下一首').setStyle(ButtonStyle.Secondary).setDisabled(none || at <= 0),
      new ButtonBuilder().setCustomId('q:now').setLabel('立即播放').setStyle(ButtonStyle.Primary).setDisabled(none),
      new ButtonBuilder().setCustomId('q:del').setLabel('移除').setStyle(ButtonStyle.Danger).setDisabled(none),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('q:prev').setLabel('上一頁').setStyle(ButtonStyle.Secondary).setDisabled(state.page === 0),
      new ButtonBuilder()
        .setCustomId('q:next')
        .setLabel('下一頁')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.page >= pages - 1),
      new ButtonBuilder().setCustomId('q:shuffle').setLabel('打亂').setStyle(ButtonStyle.Secondary).setDisabled(q.length < 2),
      new ButtonBuilder().setCustomId('q:clear').setLabel('清空').setStyle(ButtonStyle.Danger).setDisabled(!q.length),
      new ButtonBuilder().setCustomId('q:refresh').setLabel('重新整理').setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [embed], components: rows };
}

/** Applies a panel action. Returns a short message for actions worth announcing. */
export function applyQueueAction(gp, state, action, values = []) {
  const q = gp.queue;
  if (action === 'pick') {
    const v = Number(values[0]);
    state.sel = q.find((s) => s.qid === v) ?? null;
    return null;
  }
  const i = q.indexOf(state.sel);
  const move = (from, to) => {
    const [s] = q.splice(from, 1);
    q.splice(to, 0, s);
    state.page = Math.floor(to / PAGE);
  };
  switch (action) {
    case 'up':
      if (i > 0) move(i, i - 1);
      return null;
    case 'down':
      if (i >= 0 && i < q.length - 1) move(i, i + 1);
      return null;
    case 'top':
      if (i > 0) move(i, 0);
      return null;
    case 'del':
      if (i >= 0) {
        q.splice(i, 1);
        state.sel = q[i] ?? q[i - 1] ?? null; // keep editing nearby
        return null;
      }
      return null;
    case 'now':
      if (i >= 0) {
        const s = state.sel;
        gp.jump(i);
        state.sel = null;
        return `立即播放 **${clip(s.title, 80)}**`;
      }
      return null;
    case 'prev':
      state.page -= 1;
      return null;
    case 'next':
      state.page += 1;
      return null;
    case 'shuffle':
      gp.shuffle();
      return null;
    case 'clear':
      q.length = 0;
      state.sel = null;
      return '佇列已清空。';
    default:
      return null;
  }
}
