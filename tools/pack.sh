#!/usr/bin/env bash
# 打包 Bili-Mux 为 crx（CRX3 格式，无需 Chrome）。
# 只拷贝运行时必需文件到临时目录，避免旧 crx 自包含、设计源文件（icon.svg/
# icon-source.jpg/screenshots/docs）混入包体。
# 私钥 bili-mux.pem 存在则复用（扩展 ID 稳定）；不存在则自动生成（ID 会变）。
set -euo pipefail
cd "$(dirname "$0")/.."

# crx3 用 process.env.PWD 当工作目录；git bash 会把 PWD 设成 POSIX 路径（/d/xxx），
# Node 在 Windows 上会错解析成 D:\d\xxx 导致 ENOENT。清掉 PWD，让它退回 process.cwd()。
unset PWD 2>/dev/null || true

VER=$(node -e "console.log(require('./manifest.json').version)")
OUT="Bili-Mux-v${VER}.crx"
STAGE=".tmp-pack"

rm -rf "$STAGE"
mkdir -p "$STAGE/lib/ffmpeg" "$STAGE/icons"

# —— 运行时必需文件 ——
cp manifest.json content.js background.js offscreen.js offscreen.html \
   popup.html popup.js popup.css rules.json "$STAGE/"
cp lib/ffmpeg/* "$STAGE/lib/ffmpeg/"
cp icons/icon16.png icons/icon48.png icons/icon128.png "$STAGE/icons/"

# —— crx3 打包（-p 指定私钥：不存在则生成并保存，之后复用保证扩展 ID 稳定） ——
# 注意：不能经 npx 调用——npx 会重置 PWD 为 POSIX 路径，让 crx3 在 Windows 上把
# 输出路径错解析成 D:\d\xxx 而 ENOENT。这里直接 node 运行本地已安装的 crx3。
if [ ! -f node_modules/crx3/bin/crx3.js ]; then
  echo "缺少 crx3 依赖，请先执行 npm install" >&2
  exit 1
fi
rm -f "$OUT"
node node_modules/crx3/bin/crx3.js "$STAGE" -o "$OUT" -p "bili-mux.pem"

rm -rf "$STAGE"
if [ ! -f "bili-mux.pem" ]; then
  echo "⚠ 已生成新私钥 bili-mux.pem（扩展 ID 与旧包不同，已安装用户需重装）"
fi
echo "打包完成: $(ls -lh "$OUT" | awk '{print $5, $9}')"
