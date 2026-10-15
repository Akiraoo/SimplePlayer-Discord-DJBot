# SimplePlayer Discord DJBot

Simple Player 的 Discord 點歌 Bot。在語音頻道播放 [Simple Player Web Server](https://github.com/Akiraoo/SimplePlayer-Web-Server) 曲庫裡的歌，貼 Simple Player 的分享連結就能直接播，也能播 YouTube、Spotify、SoundCloud 等網路歌曲。

* **曲庫優先**：輸入歌名會先找自己的曲庫，曲庫沒有才去 YouTube Music 找
* **分享連結通用**：網頁播放器、Android、Windows 版分享出來的 `/s/`、`/p/`、`/c/` 連結都能直接貼
* **主流平台都能貼**：YouTube、YouTube Music、SoundCloud、bilibili 直接播；Spotify、Apple Music、Deezer 等平台會自動到 YouTube Music 找同一首
* **用按鈕操作**：搜尋結果可以挑歌，佇列可以直接調整順序，正在播放的訊息附控制按鈕

## 指令

| 指令 | 說明 |
| --- | --- |
| `/play` | 輸入歌名或貼連結。打字時會列出曲庫裡的歌，最後兩個選項是「在 YouTube Music 搜尋」「在 YouTube 搜尋」 |
| `/next` | 和 `/play` 一樣，但插到下一首 |
| `/search` | 列出最多 10 筆搜尋結果（只有你看得到），挑一首或多首加入佇列。來源可以選曲庫、YouTube Music、YouTube、SoundCloud、bilibili，結果下面的按鈕可以直接換來源重搜 |
| `/invite` | 把 Bot 拉進你所在的語音頻道，之後不在語音裡也能點歌 |
| `/queue` | 佇列編輯器：選一首歌後可以上移、下移、移到下一首、立即播放、移除，也能翻頁、打亂、清空 |
| `/move`、`/jump`、`/remove`、`/clear`、`/shuffle` | 用指令編輯佇列 |
| `/skip`、`/pause`、`/resume`、`/stop` | 播放控制（`/stop` 會清空佇列並離開） |
| `/nowplaying`、`/loop`、`/volume`、`/seek` | 正在播放、循環（關閉／單曲／佇列）、音量（0–150）、跳到指定時間（例如 `1:23`） |

「正在播放」訊息附封面、分享頁連結和暫停／下一首／停止按鈕。按鈕和佇列編輯只有在同一個語音頻道裡的人能用。閒置或頻道裡沒人超過一段時間，Bot 會自動離開。

## 支援的連結

| 來源 | 可以貼 | 播放方式 |
| --- | --- | --- |
| Simple Player | 單曲 `/s/<id>`（也接受 `/share/`、`/play/`）、伺服器播放清單 `/p/<名稱>`、自訂播放清單 `/c/<id>` | 從 Simple Player 伺服器串流原檔 |
| YouTube、YouTube Music、SoundCloud、bilibili、Bandcamp、niconico… | 單曲、播放清單（[yt-dlp 支援的網站](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)都可以） | yt-dlp |
| Spotify、Apple Music、Deezer | 單曲、專輯、播放清單 | 讀出歌名和長度，到 YouTube Music 找長度最接近的版本 |
| KKBOX、TIDAL、Amazon Music、LINE MUSIC | 單曲 | 讀出歌名，到 YouTube Music 找 |
| 音訊檔網址 | `.flac`、`.mp3`… 或伺服器回應是音訊的網址 | 直接串流 |

* 網路歌曲輪到它的時候才解析（連結會過期），下一首會在目前這首開始時先解析好，換歌不太會停頓
* 播放有大約 10 秒的預讀緩衝，網路短暫卡頓不會斷音
* ffmpeg 讀不了 yt-dlp 給的網址時，會自動改成讓 yt-dlp 下載再交給 ffmpeg
* 連不上 Simple Player 伺服器時（例如放曲庫的電腦關機），輸入歌名會直接改找 YouTube Music
* 一個連結最多加 200 首（`MAX_PLAYLIST` 可以改）；Spotify 的播放清單一次只讀得到前 100 首左右

## 建立 Discord Bot

1. 到 [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. **General Information**：複製 **Application ID**（就是 `CLIENT_ID`）
3. **Bot**：按 **Reset Token** 複製 Token（就是 `DISCORD_TOKEN`，不要給別人看）。不需要開任何 Privileged Gateway Intents
4. 用這個網址把 Bot 邀請到你的伺服器（把 `CLIENT_ID` 換掉）：

   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=3230720
   ```

   權限：檢視頻道、發送訊息、嵌入連結、讀取訊息紀錄、連接語音、在語音中說話。

## 安裝：Linux 伺服器（Debian／Ubuntu，建議）

用 root 執行：

```
git clone https://github.com/Akiraoo/SimplePlayer-Discord-DJBot.git /root/spbot-src
cd /root/spbot-src && sh deploy/install-debian.sh
```

安裝腳本會：

* 裝好 ffmpeg、Node.js 24（系統裡的太舊才裝）和官方版 yt-dlp
* 建立 `spbot` 使用者，把 Bot 裝到 `/opt/simpleplayer-discord-bot`
* 設成開機自動啟動、當掉自動重啟，每天自動更新 yt-dlp

第一次裝完編輯 `/opt/simpleplayer-discord-bot/.env`（見下方「設定」），再 `systemctl restart spbot`。

更新：

```
cd /root/spbot-src && git pull && sh deploy/install-debian.sh
```

`.env` 會保留。常用指令：

* 看紀錄：`journalctl -u spbot -f`
* 重開：`systemctl restart spbot`
* 手動更新 yt-dlp：`systemctl start yt-dlp-update`

## 安裝：Windows

需要：

* [Node.js](https://nodejs.org/) 22.12 以上
* FFmpeg（在 PATH 上，或在 `.env` 的 `FFMPEG` 填路徑）
* [yt-dlp](https://github.com/yt-dlp/yt-dlp) 2025.11 以上（網路歌曲才需要）：`winget install yt-dlp`，之後用 `yt-dlp -U` 更新

```
git clone https://github.com/Akiraoo/SimplePlayer-Discord-DJBot.git
cd SimplePlayer-Discord-DJBot
npm install
copy .env.example .env
```

編輯 `.env` 後執行 `npm start`（或點兩下 `start.bat`）。

YouTube 需要 JavaScript 執行環境，Bot 會把自己用的 Node.js 交給 yt-dlp，不用另外裝 Deno。

## 設定（`.env`）

| 設定 | 說明 |
| --- | --- |
| `DISCORD_TOKEN`、`CLIENT_ID` | Bot 的 Token 和 Application ID |
| `GUILD_ID` | 你的伺服器 ID。填了斜線指令會立刻出現；不填就是全域指令，第一次可能要等一小時 |
| `SP_SERVER` | Bot 從哪裡串流（Simple Player 伺服器的手機 API 埠）。同一台電腦填 `http://127.0.0.1:55555`，區網其他電腦填那台的區網位址 |
| `SP_PUBLIC` | 公開的 https 網址，用在封面和分享連結。留空會自動用伺服器設定的 `publicOrigin` |
| `FFMPEG`、`YTDLP` | 不在 PATH 上時填路徑 |
| `YTDLP_COOKIES` | 要播年齡限制或會員限定影片時，填 cookies.txt 的路徑（用瀏覽器擴充功能匯出 Netscape 格式） |
| `YTDLP_ARGS` | 額外的 yt-dlp 參數 |
| `MAX_PLAYLIST` | 一個連結最多加幾首，預設 200 |
| `DEFAULT_VOLUME` | 起始音量（0–150），預設 60 |
| `IDLE_SECONDS` | 閒置或沒人聽多久後離開，預設 180 秒 |

啟動後看到「已登入」「斜線指令已註冊」「Simple Player 曲庫：N 首」「yt-dlp 版本」就可以用了。

## 疑難排解

* **`/play` 說看不到你在語音頻道裡**：Bot 要用上面的邀請網址（`scope=bot`）加進伺服器，而且要能看到那個語音頻道
* **YouTube 播不了**：先更新 yt-dlp（`yt-dlp -U`，Linux 伺服器上是 `systemctl start yt-dlp-update`），YouTube 改版時常需要新版
* **年齡限制的影片**：設定 `YTDLP_COOKIES`
* **Spotify 連結讀不到**：Spotify 改版時可能會失效，請開 issue

## 開發

`npm test` 會跑不需要連 Discord 和網路的部分：連結解析、曲庫搜尋、Spotify 頁面解析，以及用假的 yt-dlp 測試網路歌曲。

## 相關專案

* [SimplePlayer-Web-Server](https://github.com/Akiraoo/SimplePlayer-Web-Server)：曲庫伺服器和網頁播放器
* [SimplePlayer-Windows-APP](https://github.com/Akiraoo/SimplePlayer-Windows-APP)：Windows 播放器
* [SimplePlayer-Discord-Presence](https://github.com/Akiraoo/SimplePlayer-Discord-Presence)：網頁播放器的 Discord 狀態顯示

## 授權

Apache-2.0
