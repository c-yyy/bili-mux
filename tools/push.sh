#!/usr/bin/env bash
# 自动探测本机可用的代理端口后再推送。
#
# 背景一：环境变量里的 http_proxy 未必能通 GitHub（曾经 127.0.0.1:2150 对
# github.com 返回 502，但 7897 正常）。本脚本依次探测常见代理端口，
# 选中第一个能连通 github.com 的，通过 git -c 临时覆盖推送，不改写全局配置。
#
# 背景二：PortableGit 的「系统级」配置写了 credential.helper=helper-selector，
# 它会按 credential.helperselector.selected 去调 Git Credential Manager；GCM 在本
# 环境里没有可用令牌时会挂起等待交互登录，表现为 push 卡住无输出。因此这里一律
# 先向凭据管理器取令牌、把凭据直接放进 URL 推送，并用 GIT_CONFIG_SYSTEM/GLOBAL=
# /dev/null 临时屏蔽两份配置（避免任何 credential helper 被调用）。取不到令牌才
# 退回普通推送。
#
# 用法：bash tools/push.sh [git push 的参数...]
#   例：bash tools/push.sh
#       bash tools/push.sh -u origin main
#       bash tools/push.sh --tags

set -uo pipefail

TARGET="https://github.com"
# 常见本地代理端口：Clash 7890/7891/7897，v2ray 10808/10809，SS 1080，其余为兜底
PORTS=(7897 7890 7891 10809 10808 1080 2150 8080)

# 返回 2xx/3xx 视为该代理可用。
# 超时给 10s：代理首次建连（含 DNS）可能要 6s 以上，给 6s 会误判成不可用。
probe() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 10 -x "$1" "$TARGET" 2>/dev/null
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

# 从凭据管理器取 github.com 的令牌（取不到返回空串，不把内容打到终端）
fetch_token() {
  printf 'protocol=https\nhost=github.com\n\n' \
    | git credential fill 2>/dev/null \
    | sed -n 's/^password=//p' | head -1
}

# 把 origin 的 URL 换成带凭据的形式，避免调用任何 credential helper
remote_with_token() {
  local base token
  base=$(git remote get-url origin 2>/dev/null)
  [ -z "$base" ] && return 1
  case "$base" in
    https://*@*) echo "$base"; return 0 ;;   # 已内嵌凭据
    https://*) ;;
    *) return 1 ;;                            # SSH 远端不走这条路
  esac
  token=$(fetch_token)
  [ -z "$token" ] && return 1
  echo "${base/https:\/\//https://c-yyy:${token}@}"
}

PROXY_ARGS=()
if [ -n "$PICKED" ]; then
  PROXY_ARGS=(-c "http.https://github.com.proxy=${PICKED}")
elif [ "$(probe '')" != "200" ]; then
  echo "[push] 未探测到任何可用代理，且直连不可达。"
  echo "[push] 请检查代理客户端是否运行；若端口不在下列范围内，请补进 tools/push.sh 的 PORTS："
  echo "[push]   ${PORTS[*]}"
  echo "[push] 仍要尝试直接推送请执行: git push $*"
  exit 1
else
  echo "[push] 未找到可用代理，但直连可达，直接推送"
fi

AUTH_URL=$(remote_with_token)
if [ -n "$AUTH_URL" ]; then
  # 屏蔽 system / global 两份配置：PortableGit 的系统配置会强制走
  # credential-helper-selector → GCM，在没有可用令牌时会挂起等待交互登录
  echo "[push] 使用凭据管理器中的令牌推送（已绕过 credential helper）"
  GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    git "${PROXY_ARGS[@]+"${PROXY_ARGS[@]}"}" push "$AUTH_URL" "$@"
else
  echo "[push] 凭据管理器中没有 github.com 的令牌，退回普通推送（可能需要手动登录）"
  git "${PROXY_ARGS[@]+"${PROXY_ARGS[@]}"}" push "$@"
fi
