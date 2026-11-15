#!/usr/bin/env bash
# 隔离沙盒起真宿主：独立 DSH_HOME 安装本插件，避免污染真实环境。
# 用法：bash scripts/dev-sandbox.sh [端口]   （默认 7788）
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-7788}"
SANDBOX="${TMPDIR:-/tmp}/dsh-amazon-smoke"

mkdir -p "$SANDBOX/home"
export DSH_HOME="$SANDBOX/home"

dsh plugin --profile web remove dsh-amazon-image-studio >/dev/null 2>&1 || true
dsh plugin --profile web add "file:$ROOT" >/dev/null

echo "沙盒 DSH_HOME: $DSH_HOME"
echo "http://127.0.0.1:$PORT/  （token 见启动输出）"
exec dsh --profile web --no-open --port "$PORT"
