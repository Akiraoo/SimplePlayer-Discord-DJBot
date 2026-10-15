#!/bin/sh
# Installs (or updates) the bot as a systemd service on Debian / Ubuntu.
# Run as root from the bot's folder:  sh deploy/install-debian.sh
set -eu
export DEBIAN_FRONTEND=noninteractive # never stop at a (hidden) question

APP=/opt/simpleplayer-discord-bot
SRC=$(cd "$(dirname "$0")/.." && pwd)

[ "$(id -u)" = 0 ] || { echo "請用 root 執行（sudo sh deploy/install-debian.sh）"; exit 1; }

echo "== 套件：ffmpeg、curl"
apt-get update
apt-get install -y ffmpeg curl ca-certificates

# Node.js 22.12+ (Debian's own nodejs is too old for the Discord voice library)
need_node=1
if command -v node >/dev/null 2>&1; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' && need_node=0
fi
if [ $need_node = 1 ]; then
  echo "== 安裝 Node.js 24（NodeSource）"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
echo "   node $(node -v)"

# yt-dlp: the official standalone build (Debian's package lags behind and YouTube breaks)
if ! /usr/local/bin/yt-dlp --version >/dev/null 2>&1; then
  echo "== 安裝 yt-dlp"
  curl -fL --progress-bar -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
  chmod 755 /usr/local/bin/yt-dlp
fi
echo "   yt-dlp $(/usr/local/bin/yt-dlp --version)"

echo "== 使用者 spbot"
id spbot >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin spbot

echo "== 複製程式到 $APP"
mkdir -p "$APP"
if [ "$SRC" != "$APP" ]; then
  # keep an existing .env on the server unless a new one comes along
  for f in package.json package-lock.json README.md LICENSE .env.example; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$APP/"
  done
  rm -rf "$APP/src" "$APP/deploy"
  cp -r "$SRC/src" "$SRC/deploy" "$APP/"
  if [ -f "$SRC/.env" ]; then cp "$SRC/.env" "$APP/.env"; fi
fi
[ -f "$APP/.env" ] || { cp "$APP/.env.example" "$APP/.env"; echo "   已建立 $APP/.env，請填好再啟動"; }

echo "== npm install"
cd "$APP"
if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund 
else npm install --omit=dev --no-audit --no-fund ; fi
sed -i 's/\r$//' "$APP/.env" # copied from Windows
if grep -Eq '^(FFMPEG|YTDLP)=.*[A-Za-z]:\\' "$APP/.env"; then
  echo "   注意：.env 的 FFMPEG / YTDLP 還是 Windows 路徑，請清空（留白就會用系統裡的）"
fi
if grep -Eq '^SP_SERVER=https?://(127\.0\.0\.1|localhost)' "$APP/.env"; then
  echo "   注意：.env 的 SP_SERVER 還是 127.0.0.1，要改成桌機的區網位址"
fi
chown -R spbot:spbot "$APP"
chmod 600 "$APP/.env"

echo "== systemd"
install -m 644 deploy/spbot.service /etc/systemd/system/spbot.service
install -m 644 deploy/yt-dlp-update.service /etc/systemd/system/yt-dlp-update.service
install -m 644 deploy/yt-dlp-update.timer /etc/systemd/system/yt-dlp-update.timer
systemctl daemon-reload
systemctl enable --now yt-dlp-update.timer >/dev/null
systemctl enable spbot >/dev/null
systemctl restart spbot

sleep 3
systemctl --no-pager --lines=15 status spbot || true
echo
echo "完成。看紀錄：journalctl -u spbot -f    重開：systemctl restart spbot"
