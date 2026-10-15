// Slash command definitions (registered on start-up, or with `npm run register`).

import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('invite').setDescription('把 Bot 拉進你所在的語音頻道'),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('播放：歌名、Simple Player 分享連結、YouTube／Spotify 等連結')
    .addStringOption((o) =>
      o
        .setName('query')
        .setDescription('歌名，或 Simple Player、YouTube、Spotify、SoundCloud、Apple Music… 的連結')
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('next')
    .setDescription('把歌插到下一首')
    .addStringOption((o) =>
      o.setName('query').setDescription('連結或歌名').setRequired(true).setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('搜尋，從結果挑一首或多首加入佇列')
    .addStringOption((o) => o.setName('query').setDescription('歌名、歌手…').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('source')
        .setDescription('從哪裡找（預設：曲庫＋YouTube Music）')
        .addChoices(
          { name: '曲庫＋YouTube Music', value: 'all' },
          { name: '曲庫', value: 'library' },
          { name: 'YouTube Music', value: 'ytm' },
          { name: 'YouTube', value: 'yt' },
          { name: 'SoundCloud', value: 'sc' },
          { name: 'bilibili', value: 'bili' },
        ),
    ),
  new SlashCommandBuilder().setName('skip').setDescription('跳過這首'),
  new SlashCommandBuilder().setName('stop').setDescription('停止、清空佇列並離開語音頻道'),
  new SlashCommandBuilder().setName('pause').setDescription('暫停'),
  new SlashCommandBuilder().setName('resume').setDescription('繼續播放'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('正在播放'),
  new SlashCommandBuilder().setName('queue').setDescription('查看與編輯佇列（可移動、移除、立即播放）'),
  new SlashCommandBuilder().setName('shuffle').setDescription('打亂佇列'),
  new SlashCommandBuilder().setName('clear').setDescription('清空佇列（目前這首繼續播）'),
  new SlashCommandBuilder()
    .setName('move')
    .setDescription('移動佇列裡的歌')
    .addIntegerOption((o) => o.setName('from').setDescription('原本的編號').setRequired(true).setMinValue(1))
    .addIntegerOption((o) => o.setName('to').setDescription('移到第幾首').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('jump')
    .setDescription('直接播放佇列裡的某一首')
    .addIntegerOption((o) => o.setName('position').setDescription('佇列裡的編號').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('從佇列移除一首')
    .addIntegerOption((o) =>
      o.setName('position').setDescription('佇列裡的編號（/queue 看得到）').setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('循環模式')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('模式')
        .setRequired(true)
        .addChoices(
          { name: '關閉', value: 'off' },
          { name: '單曲循環', value: 'track' },
          { name: '佇列循環', value: 'queue' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('音量（0–150）')
    .addIntegerOption((o) =>
      o.setName('percent').setDescription('百分比').setRequired(true).setMinValue(0).setMaxValue(150),
    ),
  new SlashCommandBuilder()
    .setName('seek')
    .setDescription('跳到指定時間')
    .addStringOption((o) => o.setName('time').setDescription('例如 1:23 或 83').setRequired(true)),
].map((c) => c.toJSON());
