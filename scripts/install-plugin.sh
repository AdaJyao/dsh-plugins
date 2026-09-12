#!/usr/bin/env bash
# 把预打包 tgz 装进 DSH（插件市场同构的四处登记），并在动手前备份。
#
#   DSH_HOME=/vol1/@appdata/<app>/dsh-home scripts/install-plugin.sh releases/dsh-model-live-0.3.3.tgz
#   ... --profile web       # 指定 profile（默认 web）
#   ... --dry-run           # 只打印计划，不落盘
#
# 四处登记（缺一不可）：
#   ① 实体   $DSH_HOME/plugins/<name>/<version>/        ← 解包
#   ② 软链   $DSH_HOME/profiles/<profile>/node_modules/<name>
#   ③ 花名册 $DSH_HOME/profiles/<profile>/package.json → dsh.profile.bundles[]
#   ④ 状态   $DSH_HOME/plugin-state.json → plugins["<name>"]
# 登记完**需要重启 DSH web**（花名册是启动时读的，没有热更新）。
set -uo pipefail
TGZ="${1:-}"
[ -n "$TGZ" ] && [ -f "$TGZ" ] || { echo "用法: $0 <插件.tgz> [--profile web] [--dry-run]" >&2; exit 2; }
shift
PROFILE=web
DRY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[ -n "${DSH_HOME:-}" ] || { echo "请先设置 DSH_HOME（DSH 的家目录）" >&2; exit 2; }
[ -d "$DSH_HOME" ] || { echo "DSH_HOME 不存在：$DSH_HOME" >&2; exit 2; }

# tgz 必须是"单顶层目录"结构（npm pack 的产物就是），取出包名与版本
TOP="$(tar -tzf "$TGZ" | head -1 | cut -d/ -f1)"
[ -n "$TOP" ] || { echo "读不出包名" >&2; exit 1; }
NAME="$(printf '%s' "$TOP" | sed 's/-[0-9][0-9.]*$//')"
VERSION="$(printf '%s' "$TOP" | sed 's/^.*-//')"
ENTITY="$DSH_HOME/plugins/$NAME/$VERSION"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PKGJSON="$PROFILE_DIR/package.json"

echo "插件: $NAME@$VERSION"
echo "  ① 实体   -> $ENTITY"
echo "  ② 软链   -> $PROFILE_DIR/node_modules/$NAME"
echo "  ③ 花名册 -> $PKGJSON 的 dsh.profile.bundles[]"
echo "  ④ 状态   -> $DSH_HOME/plugin-state.json"
[ "$DRY" = 1 ] && { echo "（--dry-run，什么都没改）"; exit 0; }

TS="$(date +%Y%m%d-%H%M%S)"
BAK="$DSH_HOME/plugin-install-backup/$TS"
mkdir -p "$BAK"
[ -f "$PKGJSON" ] && cp "$PKGJSON" "$BAK/profile-package.json"
[ -f "$DSH_HOME/plugin-state.json" ] && cp "$DSH_HOME/plugin-state.json" "$BAK/plugin-state.json"
echo "  备份 -> $BAK"

mkdir -p "$ENTITY"
tar -xzf "$TGZ" -C "$ENTITY" --strip-components=1
mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn "$ENTITY" "$PROFILE_DIR/node_modules/$NAME"

python3 - "$PKGJSON" "$NAME" "$DSH_HOME/plugin-state.json" "$VERSION" <<'PY'
import json, os, sys
pkg_path, name, state_path, version = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
# ③ 花名册
pkg = {}
if os.path.exists(pkg_path):
    with open(pkg_path, encoding='utf-8') as f:
        pkg = json.load(f)
dsh = pkg.setdefault('dsh', {})
profile = dsh.setdefault('profile', {})
bundles = profile.setdefault('bundles', [])
if name not in bundles:
    bundles.append(name)
with open(pkg_path, 'w', encoding='utf-8') as f:
    json.dump(pkg, f, ensure_ascii=False, indent=2)
# ④ 状态
state = {}
if os.path.exists(state_path):
    with open(state_path, encoding='utf-8') as f:
        state = json.load(f)
plugins = state.setdefault('plugins', {})
plugins[name] = {'version': version, 'source': 'user', 'installed': True, 'enabled': True}
with open(state_path, 'w', encoding='utf-8') as f:
    json.dump(state, f, ensure_ascii=False, indent=2)
print('  已登记: bundles +=', name, '| plugin-state:', plugins[name])
PY

echo
echo "装好了。**重启 DSH web** 之后才会加载（花名册在启动时读）："
echo "  · 常见做法：重启那个 DSH 进程/应用；本机 fnOS 部署是写重启标志交给它的 supervisor。"
echo "  · 回滚：把 $BAK 里的两个 json 拷回去，删掉实体目录与软链。"
