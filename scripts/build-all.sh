#!/usr/bin/env bash
# 全量构建：逐个插件跑它的 build（如果有），再 npm pack 到 releases/。
#
#   scripts/build-all.sh            # 构建 + 打包
#   scripts/build-all.sh --install  # 构建 + 打包，并直接装进 $DSH_HOME（可选）
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
mkdir -p releases

fail=0
for dir in packages/*/; do
  name="$(basename "$dir")"
  pkg="$HERE/$dir"
  [ -f "$pkg/package.json" ] || { echo "跳过 $name（没有 package.json）"; continue; }
  version="$(python3 -c "import json;print(json.load(open('$pkg/package.json'))['version'])" 2>/dev/null)"
  echo "== $name@$version"
  if [ -f "$pkg/client/build.mjs" ] && grep -q '"build"' "$pkg/package.json"; then
    ( cd "$pkg" && node client/build.mjs ) || { echo "  构建失败"; fail=1; continue; }
  else
    echo "  （无客户端构建步骤）"
  fi
  ( cd "$pkg" && npm pack --pack-destination "$HERE/releases" >/dev/null 2>&1 ) || { echo "  打包失败"; fail=1; continue; }
  tgz="$HERE/releases/$name-$version.tgz"
  [ -f "$tgz" ] && echo "  -> releases/$(basename "$tgz")  $(stat -c%s "$tgz") 字节  sha256=$(sha256sum "$tgz" | cut -c1-16)…" || { echo "  找不到产物 $tgz"; fail=1; }
done

echo
echo "== releases/ =="
ls -la releases/ | tail -n +2

if [ "${1:-}" = "--install" ]; then
  [ -n "${DSH_HOME:-}" ] || { echo "需要 DSH_HOME 才能 --install" >&2; exit 2; }
  for tgz in releases/*.tgz; do "$HERE/scripts/install-plugin.sh" "$tgz" || fail=1; done
fi
exit "$fail"
