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

# —— 合规修补：同 pack.sh，去掉 ffmpeg.min.js 里指向 unpkg CDN 的默认 corePath ——
node tools/patch-ffmpeg.js

cp manifest.json content.js background.js offscreen.js offscreen.html \
   popup.html popup.js popup.css rules.json "$STAGE/"
cp lib/ffmpeg/*.js lib/ffmpeg/*.wasm "$STAGE/lib/ffmpeg/"
cp icons/icon16.png icons/icon48.png icons/icon128.png "$STAGE/icons/"

rm -f "$OUT"
# 在 STAGE 内打包，确保 zip 顶层就是扩展文件，不夹带目录层级。
# Windows 环境没有 zip 命令，改用 python 标准库 zipfile（-x ".*" 等价：跳过隐藏文件/目录）。
python - "$STAGE" "$OUT" <<'PY'
import zipfile, os, sys
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(stage):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for name in files:
            if name.startswith('.'):
                continue
            full = os.path.join(root, name)
            z.write(full, os.path.relpath(full, stage))
PY
rm -rf "$STAGE"

echo "zip 完成: $(ls -lh "$OUT" | awk '{print $5, $9}')"
