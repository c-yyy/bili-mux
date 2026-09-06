#!/usr/bin/env bash
# 自动探测本机可用的代理端口后再推送。
#
# 背景：环境变量里的 http_proxy 未必能通 GitHub（曾经 127.0.0.1:2150 对
# github.com 返回 502，但 7897 正常）。本脚本依次探测常见代理端口，
# 选中第一个能连通 github.com 的，通过 git -c 临时覆盖推送，不改写全局配置。
#
# 用法：bash tools/push.sh [git push 的参数...]
#   例：bash tools/push.sh
#       bash tools/push.sh -u origin main
#       bash tools/push.sh --tags

set -uo pipefail

TARGET="https://github.com"
# 常见本地代理端口：Clash 7890/7891/7897，v2ray 10808/10809，SS 1080，其余为兜底
PORTS=(7897 7890 7891 10809 10808 1080 2150 8080)

# 返回 2xx/3xx 视为该代理可用
probe() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 6 -x "$1" "$TARGET" 2>/dev/null
}

is_ok() {
  case "$1" in
    200|201|204|301|302|307|308) return 0 ;;
    *) return 1 ;;
  esac
}

PICKED=""
for p in "${PORTS[@]}"; do
  # 先试 SOCKS5（少了 CONNECT 隧道这一层，通常比 HTTP 代理稳），再试 HTTP
  for scheme in socks5 http; do
    url="${scheme}://127.0.0.1:${p}"
    code=$(probe "$url")
    if is_ok "$code"; then
      PICKED="$url"
      echo "[push] 可用代理: ${url} (HTTP ${code})"
      break 2
    fi
  done
done

if [ -n "$PICKED" ]; then
  git -c "http.https://github.com.proxy=${PICKED}" push "$@"
elif [ "$(probe '')" = "200" ]; then
  echo "[push] 未找到可用代理，但直连可达，直接推送"
  git push "$@"
else
  echo "[push] 未探测到任何可用代理，且直连不可达。"
  echo "[push] 请检查代理客户端是否运行；若端口不在下列范围内，请补进 tools/push.sh 的 PORTS："
  echo "[push]   ${PORTS[*]}"
  echo "[push] 仍要尝试直接推送请执行: git push $*"
  exit 1
fi
