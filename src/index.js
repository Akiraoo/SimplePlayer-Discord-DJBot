// Simple Player Discord bot: plays Simple Player share links and library songs, audio URLs,
// YouTube / SoundCloud / bilibili… (yt-dlp) and Spotify / Apple Music / Deezer links
// (found on YouTube Music) in voice channels.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
} from 'discord.js';

import { commands } from './commands.js';
import { GuildPlayer } from './player.js';
import { applyQueueAction, panelState, renderQueue } from './queue-panel.js';
import { getSearch, renderSearch, runSearch } from './search-panel.js';
import { SimplePlayer } from './simpleplayer.js';
import { prepare, resolve } from './sources.js';
import { clip, fmtTime, parseTime } from './util.js';
import { YtDlp } from './ytdlp.js';

const env = process.env;
for (const k of ['DISCORD_TOKEN', 'CLIENT_ID', 'SP_SERVER']) {
  if (!env[k]) {
    console.error(`缺少設定 ${k}：請把 .env.example 複製成 .env 並填好。`);
    process.exit(1);
  }
}
const FFMPEG = env.FFMPEG || 'ffmpeg';
const DEFAULT_VOLUME = Math.max(0, Math.min(150, Number(env.DEFAULT_VOLUME) || 60));
const IDLE_MS = (Number(env.IDLE_SECONDS) || 180) * 1000;
const ACCENT = 0x2dd4bf;

const sp = new SimplePlayer(env.SP_SERVER, env.SP_PUBLIC);
const yt = new YtDlp({ bin: env.YTDLP, cookies: env.YTDLP_COOKIES, extra: env.YTDLP_ARGS });
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

/** @type {Map<string, GuildPlayer>} */
const players = new Map();
/** the last "now playing" message per server, so it can be replaced instead of piling up */
const npMessages = new Map();

function playerFor(guildId) {
  let gp = players.get(guildId);
  if (!gp) {
    gp = new GuildPlayer(guildId, {
      ffmpeg: FFMPEG,
      volume: DEFAULT_VOLUME,
      prepare: (song, o) => prepare(yt, song, o),
      onNowPlaying: (g) => postNowPlaying(g).catch(() => {}),
      onEmpty: (g) => {
        g.textChannel?.send({ embeds: [note('佇列播完了。')] }).catch(() => {});
      },
      onError: (g, msg) => {
        g.textChannel?.send({ embeds: [note(msg)] }).catch(() => {});
      },
    });
    players.set(guildId, gp);
  }
  return gp;
}

/* ---------------- embeds ---------------- */

function note(text) {
  return new EmbedBuilder().setColor(ACCENT).setDescription(text);
}

function songLine(s) {
  const who = s.artist ? ` — ${s.artist}` : '';
  const len = s.duration ? ` \`${fmtTime(s.duration)}\`` : '';
  const title = s.link?.startsWith('https://') ? `[${clip(s.title, 80)}](${s.link})` : clip(s.title, 80);
  return `${title}${clip(who, 60)}${len}`;
}

function nowPlayingEmbed(gp) {
  const s = gp.current;
  const e = new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name: gp.paused ? '已暫停' : '正在播放' })
    .setTitle(clip(s.title, 256))
    .setDescription([s.artist, s.album].filter(Boolean).join(' · ') || null);
  if (s.link?.startsWith('https://')) e.setURL(s.link);
  if (s.cover) e.setThumbnail(s.cover);
  const len = s.live ? '直播' : s.duration ? fmtTime(s.duration) : '?';
  const fields = [{ name: '長度', value: len, inline: true }];
  if (s.requester) fields.push({ name: '點歌', value: `<@${s.requester}>`, inline: true });
  if (gp.queue.length) fields.push({ name: '接下來', value: clip(gp.queue[0].title, 100), inline: true });
  if (gp.loop !== 'off') fields.push({ name: '循環', value: gp.loop === 'track' ? '單曲' : '佇列', inline: true });
  e.addFields(fields);
  const from = sourceName(s);
  if (from) e.setFooter({ text: from });
  return e;
}

/** Where a song comes from, for the embed footer. */
function sourceName(s) {
  if (s.source === 'lazy') return `${s.service}${s.page ? ' → 在 YouTube Music 播放' : ''}`;
  if (s.source === 'ytdlp') {
    try {
      const host = new URL(s.page).hostname.replace(/^(www|m)\./, '');
      if (/youtube\.com$|youtu\.be$/.test(host)) return host.startsWith('music.') ? 'YouTube Music' : 'YouTube';
      return host;
    } catch {
      return null;
    }
  }
  return null;
}

function controls(gp) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('np:toggle')
      .setLabel(gp.paused ? '繼續' : '暫停')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('np:skip').setLabel('下一首').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('np:stop').setLabel('停止').setStyle(ButtonStyle.Danger),
  );
}

async function postNowPlaying(gp) {
  if (!gp.textChannel || !gp.current) return;
  const old = npMessages.get(gp.guildId);
  npMessages.delete(gp.guildId);
  old?.delete().catch(() => {});
  const msg = await gp.textChannel.send({ embeds: [nowPlayingEmbed(gp)], components: [controls(gp)] });
  npMessages.set(gp.guildId, msg);
}

/* ---------------- commands ---------------- */

/** The voice channel the user is in (asks Discord when it isn't in the cache yet). */
async function userVoiceChannel(interaction) {
  const cached = interaction.member?.voice?.channel;
  if (cached) return cached;
  const states = interaction.guild?.voiceStates;
  if (typeof states?.fetch !== 'function') return null;
  try {
    const vs = await states.fetch(interaction.user.id, { force: true });
    if (!vs?.channel) {
      console.warn(
        `[voice] ${interaction.user.tag}: voice state ${vs?.channelId ?? 'none'}, channel not visible to the bot`,
      );
    }
    return vs?.channel ?? null;
  } catch (e) {
    // 404 = not in a voice channel; 403 / Missing Access = the bot can't see that channel
    console.warn(`[voice] ${interaction.user.tag}: ${e.status ?? ''} ${e.message}`);
    return null;
  }
}

/**
 * Where to play: the user's voice channel, or (when `botChannelOk`) the one the bot is
 * already in after /invite.
 */
async function needVoice(interaction, botChannelOk = false) {
  let channel = await userVoiceChannel(interaction);
  if (!channel && botChannelOk) {
    const gp = players.get(interaction.guildId);
    if (gp?.connected) channel = interaction.guild.channels.cache.get(gp.channelId) ?? null;
  }
  if (!channel) {
    await interaction.reply({
      embeds: [note('Bot 看不到你在語音頻道裡：先進一個語音頻道，或先用 `/invite` 把 Bot 拉進去。')],
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return channel;
}

/** Joins the channel and queues songs; returns what to say. Throws when it can't join. */
async function addSongs(interaction, channel, list, { insertNext = false, label = null } = {}) {
  const gp = playerFor(interaction.guildId);
  gp.textChannel = interaction.channel;
  await gp.connect(channel);
  // copies: the same search result can be added twice
  const songs = list.map(({ from, _pending, ...s }) => ({ ...s, requester: interaction.user.id }));
  const wasIdle = !gp.current;
  const pos = insertNext ? gp.playNext(songs) : gp.enqueue(songs);
  if (songs.length > 1) return `加入 **${clip(label || '播放清單', 80)}**，共 ${songs.length} 首。`;
  if (wasIdle) return `開始播放 ${songLine(songs[0])}`;
  return `加入佇列第 ${pos} 首：${songLine(songs[0])}`;
}

async function handlePlay(interaction, insertNext) {
  const channel = await needVoice(interaction, true);
  if (!channel) return;
  await interaction.deferReply();
  const query = interaction.options.getString('query', true);
  let result;
  try {
    result = await resolve(sp, query, yt);
  } catch (e) {
    return interaction.editReply({ embeds: [note(`讀取失敗：${e.message}`)] });
  }
  if (!result.songs.length) {
    return interaction.editReply({ embeds: [note(result.error || '沒有可以播放的內容。')] });
  }
  let text;
  try {
    text = await addSongs(interaction, channel, result.songs, { insertNext, label: result.label });
  } catch (e) {
    return interaction.editReply({ embeds: [note(e.message)] });
  }
  if (result.songs.length > 1 && result.via) text += `\n${result.via} 的歌會在播放前到 YouTube Music 找同一首。`;
  if (result.fromWeb) {
    text += result.fromWeb === 'down'
      ? '\n（連不上 Simple Player 伺服器，這是 YouTube Music 的搜尋結果）'
      : '\n（曲庫裡沒有，這是 YouTube Music 的搜尋結果）';
  }
  return interaction.editReply({ embeds: [note(text)] });
}

async function handleCommand(interaction) {
  const name = interaction.commandName;
  if (name === 'invite') {
    const channel = await needVoice(interaction);
    if (!channel) return undefined;
    await interaction.deferReply();
    const gp = playerFor(interaction.guildId);
    gp.textChannel = interaction.channel;
    try {
      await gp.connect(channel);
    } catch (e) {
      return interaction.editReply({ embeds: [note(e.message)] });
    }
    gp.idleSince = Date.now(); // the idle timer starts now, not from before it was called
    return interaction.editReply({
      embeds: [note(`來了！已加入 <#${channel.id}>，用 \`/play\` 點歌。`)],
    });
  }
  if (name === 'play') return handlePlay(interaction, false);
  if (name === 'search') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const query = interaction.options.getString('query', true).trim();
    const source = interaction.options.getString('source') || 'all';
    const { token, state } = await runSearch(sp, yt, query, source, interaction.user.id);
    return interaction.editReply(renderSearch(token, state));
  }
  if (name === 'next') return handlePlay(interaction, true);

  const gp = players.get(interaction.guildId);
  const reply = (text, ephemeral = false) =>
    interaction.reply({ embeds: [note(text)], flags: ephemeral ? MessageFlags.Ephemeral : undefined });
  if (!gp || (!gp.current && name !== 'queue' && name !== 'stop')) {
    return reply('現在沒有在播放。', true);
  }

  switch (name) {
    case 'skip': {
      const title = gp.current.title;
      gp.skip();
      return reply(`跳過 **${clip(title, 80)}**`);
    }
    case 'stop':
      gp.stop();
      npMessages.get(interaction.guildId)?.delete().catch(() => {});
      npMessages.delete(interaction.guildId);
      return reply('已停止，掰掰。');
    case 'pause':
      gp.pause();
      return reply('已暫停。');
    case 'resume':
      gp.resume();
      return reply('繼續播放。');
    case 'nowplaying': {
      const e = nowPlayingEmbed(gp);
      const s = gp.current;
      const from = sourceName(s);
      const at = gp.preparing ? '載入中…' : `${fmtTime(gp.position)} / ${s.live ? '直播' : s.duration ? fmtTime(s.duration) : '?'}`;
      e.setFooter({ text: from ? `${at} · ${from}` : at });
      return interaction.reply({ embeds: [e] });
    }
    case 'queue':
      if (!gp.current && !gp.queue.length) return reply('佇列是空的。', true);
      return interaction.reply(renderQueue(gp));
    case 'clear': {
      const n = gp.queue.length;
      gp.queue.length = 0;
      return reply(`清空了 ${n} 首。`);
    }
    case 'move': {
      const from = interaction.options.getInteger('from', true) - 1;
      const to = Math.min(interaction.options.getInteger('to', true) - 1, gp.queue.length - 1);
      if (from < 0 || from >= gp.queue.length) return reply('佇列裡沒有這個編號。', true);
      const [s] = gp.queue.splice(from, 1);
      gp.queue.splice(to, 0, s);
      return reply(`**${clip(s.title, 80)}** 移到第 ${to + 1} 首`);
    }
    case 'jump': {
      const i = interaction.options.getInteger('position', true) - 1;
      if (i < 0 || i >= gp.queue.length) return reply('佇列裡沒有這個編號。', true);
      const s = gp.queue[i];
      gp.jump(i);
      return reply(`立即播放 **${clip(s.title, 80)}**`);
    }
    case 'shuffle':
      gp.shuffle();
      return reply(`打亂了 ${gp.queue.length} 首。`);
    case 'remove': {
      const i = interaction.options.getInteger('position', true) - 1;
      if (i < 0 || i >= gp.queue.length) return reply('佇列裡沒有這個編號。', true);
      const [s] = gp.queue.splice(i, 1);
      return reply(`移除 **${clip(s.title, 80)}**`);
    }
    case 'loop': {
      gp.loop = interaction.options.getString('mode', true);
      return reply(`循環：${{ off: '關閉', track: '單曲循環', queue: '佇列循環' }[gp.loop]}`);
    }
    case 'volume': {
      gp.setVolume(interaction.options.getInteger('percent', true));
      return reply(`音量 ${gp.volume}%`);
    }
    case 'seek': {
      const t = parseTime(interaction.options.getString('time', true));
      if (t === null) return reply('時間格式像 1:23 或 83。', true);
      if (gp.current.live) return reply('直播不能跳轉。', true);
      if (gp.current.duration && t >= gp.current.duration) return reply('超過這首歌的長度了。', true);
      if (!gp.seek(t)) return reply('這首還在載入，等一下再試。', true);
      return reply(`跳到 ${fmtTime(t)}`);
    }
  }
  return undefined;
}

async function handleAutocomplete(interaction) {
  const value = interaction.options.getFocused();
  const q = value.trim();
  if (!q || /^https?:\/\//i.test(q)) return interaction.respond([]);
  const hits = await sp.search(q, 23).catch(() => []);
  // the library first; searching the web is the last two choices (a search takes too long
  // to run while typing, so it happens after picking)
  return interaction.respond([
    ...hits.map((t) => ({
      name: clip(t.artist ? `${t.title} — ${t.artist}` : t.title, 100),
      value: `sp:${t.id}`.slice(0, 100),
    })),
    { name: clip(`在 YouTube Music 搜尋「${q}」`, 100), value: `ytm:${q}`.slice(0, 100) },
    { name: clip(`在 YouTube 搜尋「${q}」`, 100), value: `yt:${q}`.slice(0, 100) },
  ]);
}

/** The /queue editor: song picker and buttons. */
async function handleQueuePanel(interaction) {
  const gp = players.get(interaction.guildId);
  if (!gp) {
    return interaction.reply({ embeds: [note('現在沒有在播放。')], flags: MessageFlags.Ephemeral });
  }
  if (gp.connected && interaction.member?.voice?.channelId !== gp.channelId) {
    return interaction.reply({ embeds: [note('要在同一個語音頻道才能編輯佇列。')], flags: MessageFlags.Ephemeral });
  }
  const state = panelState(interaction.message.id);
  const action = interaction.customId.slice(2);
  const values = interaction.isStringSelectMenu() ? interaction.values : [];
  const said = applyQueueAction(gp, state, action, values);
  await interaction.update(renderQueue(gp, state));
  if (said) gp.textChannel?.send({ embeds: [note(`${said}（<@${interaction.user.id}>）`)] }).catch(() => {});
  return undefined;
}

/** Picks and source switches on a /search result list. */
async function handleSearchPanel(interaction) {
  const [, action, token, extra] = interaction.customId.split(':');
  const state = getSearch(token);
  if (!state) {
    return interaction.reply({ embeds: [note('這個搜尋過期了，再用一次 `/search`。')], flags: MessageFlags.Ephemeral });
  }
  if (action === 'src') {
    await interaction.deferUpdate();
    const { state: fresh } = await runSearch(sp, yt, state.query, extra, interaction.user.id, token);
    return interaction.editReply(renderSearch(token, fresh));
  }
  let picked = [];
  if (action === 'pick') picked = interaction.values.map((v) => state.songs[Number(v)]).filter(Boolean);
  else if (action === 'first' || action === 'firstnext') picked = state.songs.slice(0, 1);
  else if (action === 'all') picked = state.songs;
  if (!picked.length) return interaction.deferUpdate();

  const channel = await needVoice(interaction, true);
  if (!channel) return undefined;
  await interaction.deferUpdate();
  let text;
  try {
    text = await addSongs(interaction, channel, picked, {
      insertNext: action === 'firstnext',
      label: `「${state.query}」的搜尋結果`,
    });
  } catch (e) {
    return interaction.followUp({ embeds: [note(e.message)], flags: MessageFlags.Ephemeral });
  }
  await interaction.editReply(renderSearch(token, state)).catch(() => {}); // clears the picker
  return interaction.followUp({ embeds: [note(`${text}（<@${interaction.user.id}>）`)] });
}

async function handleButton(interaction) {
  const gp = players.get(interaction.guildId);
  if (!gp?.current) {
    return interaction.reply({ embeds: [note('現在沒有在播放。')], flags: MessageFlags.Ephemeral });
  }
  // only people in the bot's voice channel can use the buttons
  if (interaction.member?.voice?.channelId !== gp.channelId) {
    return interaction.reply({ embeds: [note('要在同一個語音頻道才能操作。')], flags: MessageFlags.Ephemeral });
  }
  switch (interaction.customId) {
    case 'np:toggle':
      if (gp.paused) gp.resume();
      else gp.pause();
      return interaction.update({ embeds: [nowPlayingEmbed(gp)], components: [controls(gp)] });
    case 'np:skip':
      await interaction.deferUpdate();
      gp.skip();
      return undefined;
    case 'np:stop':
      gp.stop();
      npMessages.delete(interaction.guildId);
      return interaction.message.delete().catch(() => {});
  }
  return undefined;
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.inGuild()) return;
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('np:')) return await handleButton(interaction);
    if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('s:')) {
      return await handleSearchPanel(interaction);
    }
    if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('q:')) {
      return await handleQueuePanel(interaction);
    }
  } catch (e) {
    console.error('interaction failed:', e);
    if (interaction.isRepliable() && !interaction.replied) {
      const payload = { embeds: [note(`出錯了：${e.message}`)], flags: MessageFlags.Ephemeral };
      (interaction.deferred ? interaction.editReply(payload) : interaction.reply(payload)).catch(() => {});
    }
  }
});

// Leave when nothing has played for a while, or everyone else has left the channel.
const emptySince = new Map();
setInterval(() => {
  for (const gp of players.values()) {
    if (!gp.connected) continue;
    const channel = client.channels.cache.get(gp.channelId);
    const listeners = channel?.members?.filter((m) => !m.user.bot).size ?? 0;
    if (listeners === 0) {
      if (!emptySince.has(gp.guildId)) emptySince.set(gp.guildId, Date.now());
    } else {
      emptySince.delete(gp.guildId);
    }
    const alone = emptySince.has(gp.guildId) && Date.now() - emptySince.get(gp.guildId) > IDLE_MS;
    const idle = !gp.current && Date.now() - gp.idleSince > IDLE_MS;
    if (alone || idle) {
      gp.textChannel?.send({ embeds: [note(alone ? '大家都走了，先離開了。' : '閒置太久，先離開了。')] }).catch(() => {});
      gp.stop();
      emptySince.delete(gp.guildId);
      npMessages.get(gp.guildId)?.delete().catch(() => {});
      npMessages.delete(gp.guildId);
    }
  }
}, 30_000);

client.once(Events.ClientReady, async (c) => {
  console.log(`已登入：${c.user.tag}`);
  try {
    const rest = new REST().setToken(env.DISCORD_TOKEN);
    const route = env.GUILD_ID
      ? Routes.applicationGuildCommands(env.CLIENT_ID, env.GUILD_ID)
      : Routes.applicationCommands(env.CLIENT_ID);
    await rest.put(route, { body: commands });
    console.log(`斜線指令已註冊（${env.GUILD_ID ? '這個伺服器' : '全域'}）`);
  } catch (e) {
    console.error('註冊斜線指令失敗：', e.message);
  }
  try {
    const n = (await sp.tracks()).length;
    console.log(`Simple Player 曲庫：${n} 首（${sp.server}）`);
  } catch (e) {
    console.error('連不上 Simple Player 伺服器：', e.message);
  }
  try {
    const v = (await yt.run(['--version'], 15_000)).trim();
    console.log(`yt-dlp ${v}（YouTube、SoundCloud、Spotify 等連結可用）`);
  } catch (e) {
    console.warn(e.code === 'NO_YTDLP' ? `${e.message.replace(/`/g, '')}（只會影響網路歌曲）` : `yt-dlp：${e.message}`);
  }
});

client.login(env.DISCORD_TOKEN);
