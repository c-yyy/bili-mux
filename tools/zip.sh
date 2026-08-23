#!/usr/bin/env bash
# 打 Chrome 应用商店上传用的 zip：只含运行时必需文件。
# 排除：.git/.workbuddy/_metadata/node_modules、crx/pem、设计源文件
# （icon.svg/icon-source.jpg/screenshots/docs/README）、构建脚本。
set -euo pipefail
cd "$(dirname "$0")/.."

VER=$(node -e "console.log(require('./manifest.json').version)")
OUT="Bili-Mux-v${VER}.zip"
STAGE=".tmp-zip"

rm -rf "$STAGE"
mkdir -p "$STAGE/lib/ffmpeg" "$STAGE/icons"

cp manifest.json content.js background.js offscreen.js offscreen.html \
   popup.html popup.js popup.css rules.json "$STAGE/"
cp lib/ffmpeg/* "$STAGE/lib/ffmpeg/"
cp icons/icon16.png icons/icon48.png icons/icon128.png "$STAGE/icons/"

rm -f "$OUT"
# 在 STAGE 内打包，确保 zip 顶层就是扩展文件，不夹带目录层级
(cd "$STAGE" && zip -r -X "../$OUT" . -x ".*") >/dev/null
rm -rf "$STAGE"

echo "zip 完成: $(ls -lh "$OUT" | awk '{print $5, $9}')"
