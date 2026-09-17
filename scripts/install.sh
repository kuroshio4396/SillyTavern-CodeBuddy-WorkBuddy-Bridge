#!/usr/bin/env bash
#
# 把 SillyTavern × CodeBuddy / WorkBuddy Bridge 安装到指定的 SillyTavern 目录。
#
# 用法：
#   ./install.sh /path/to/SillyTavern
#   ./install.sh /path/to/SillyTavern --dry-run
#
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "用法: $0 <SillyTavern 根目录> [--dry-run]" >&2
    exit 1
fi

ST_PATH="$1"
DRY_RUN="no"
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN="yes"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SRC_PLUGIN="$REPO_ROOT/server-plugin"
SRC_EXT="$REPO_ROOT/ui-extension"

step() { printf '==> %s\n' "$1"; }
ok()   { printf '    %s\n' "$1"; }
warn() { printf '    %s\n' "$1"; }
die()  { printf '    %s\n' "$1" >&2; exit 1; }

echo
echo "SillyTavern × CodeBuddy / WorkBuddy Bridge —— 安装"
echo "────────────────────────────────────────────────"
[[ "$DRY_RUN" == "yes" ]] && warn "（dry-run 模式：只预览，不写盘）"
echo

# ── 1. 校验源 ──
step "检查安装源"
for d in "$SRC_PLUGIN" "$SRC_EXT"; do
    [[ -f "$d/index.js" ]] || die "安装源不完整，未找到 $d/index.js。请在仓库根目录下的 scripts/ 里运行本脚本。"
    ok "找到 $d"
done

# ── 2. 校验目标 ──
step "检查 SillyTavern 目录"
[[ -d "$ST_PATH" ]] || die "目录不存在：$ST_PATH"
ST="$(cd "$ST_PATH" && pwd)"
[[ -f "$ST/server.js" ]] || die "$ST 里没有 server.js，这看起来不是 SillyTavern 根目录。"
THIRD_PARTY="$ST/public/scripts/extensions/third-party"
[[ -d "$THIRD_PARTY" ]] || die "找不到 $THIRD_PARTY，ST 目录结构可能不匹配。"
ok "SillyTavern 根目录：$ST"

DST_PLUGIN="$ST/plugins/cbwb-bridge"
DST_EXT="$THIRD_PARTY/cbwb-bridge"

# ── 3. config.yaml 开关 ──
step "处理 config.yaml 的 enableServerPlugins"
CONFIG="$ST/config.yaml"
if [[ ! -f "$CONFIG" ]]; then
    warn "未找到 config.yaml —— 请手动把 enableServerPlugins 设为 true。"
elif grep -Eq '^[[:space:]]*enableServerPlugins[[:space:]]*:[[:space:]]*true' "$CONFIG"; then
    ok "enableServerPlugins 已经是 true，无需改动。"
elif grep -Eq '^[[:space:]]*enableServerPlugins[[:space:]]*:' "$CONFIG"; then
    BACKUP="$CONFIG.bak-cbwb-$(date +%Y%m%d-%H%M%S)"
    if [[ "$DRY_RUN" == "no" ]]; then
        cp "$CONFIG" "$BACKUP"
        sed -i.tmp -E 's/^([[:space:]]*enableServerPlugins[[:space:]]*:)[[:space:]]*.*/\1 true/' "$CONFIG"
        rm -f "$CONFIG.tmp"
    fi
    ok "已开启 enableServerPlugins（原文件备份为 $(basename "$BACKUP")）"
else
    warn "未找到 enableServerPlugins 配置项 —— 请手动添加 enableServerPlugins: true。"
fi

# ── 4. 拷贝 ──
step "拷贝文件"
copy_tree() {
    local from="$1" to="$2" name="$3"
    if [[ "$DRY_RUN" == "yes" ]]; then
        ok "[dry-run] $name：$from  →  $to"
        return
    fi
    [[ -d "$to" ]] && { warn "$name 目标已存在，覆盖：$to"; rm -rf "$to"; }
    mkdir -p "$to"
    cp -R "$from/." "$to/"
    ok "$name → $to（$(find "$to" -type f | wc -l | tr -d ' ') 个文件）"
}
copy_tree "$SRC_PLUGIN" "$DST_PLUGIN" "服务器插件"
copy_tree "$SRC_EXT"    "$DST_EXT"    "前端扩展"

# ── 5. 收尾 ──
echo
echo "────────────────────────────────────────────────"
if [[ "$DRY_RUN" == "yes" ]]; then
    echo "dry-run 结束，未做任何改动。去掉 --dry-run 即可实际安装。"
else
    cat <<'EOF'
安装完成。接下来：
  1) 启动 SillyTavern（./start.sh 或 Start.bat）
  2) 启动日志里应出现：
       [cbwb-bridge] OpenAI 兼容代理已监听 http://127.0.0.1:8791/v1
       [cbwb-bridge] 插件已加载（v1.1.0）…
  3) 打开 http://127.0.0.1:8000/ → 扩展设置 → 「CodeBuddy / WorkBuddy 桥接」
  4) 依次点两条渠道的「登录」（需要真人在浏览器完成官方授权）
  5) 回来点「接入本地桥接」，然后正常对话

提示：登录后别忘了看一眼「积分 / 用量」卡片，方便控制消耗。
EOF
fi
echo
