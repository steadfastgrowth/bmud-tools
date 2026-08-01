#!/usr/bin/env bash
# Package B-Mud + install on a connected KaiOS device (jailbroken 2780 with appscmd)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist/bmud.kaios.zip}"
VERSION="${BMUD_VERSION:-0.7.0}"
BUILD_ID="DEPLOY_$(date +%s)"
ADB="${ADB:-adb}"

# Optional: jailbreak adb vendor keys
if [ -n "${N2780_JB:-}" ] && [ -f "$N2780_JB/adbkey" ]; then
  export ADB_VENDOR_KEYS="${ADB_VENDOR_KEYS:-$N2780_JB/adbkey:$HOME/.android/adbkey}"
fi

echo "==> B-Mud deploy ($VERSION · $BUILD_ID)"
mkdir -p "$(dirname "$OUT")"

python3 - <<PY
import json, pathlib
root = pathlib.Path("$ROOT")
ver = "$VERSION"
for name in ("manifest.webapp", "manifest.webmanifest"):
    p = root / name
    data = json.loads(p.read_text())
    data.setdefault("b2g_features", {})["version"] = ver
    p.write_text(json.dumps(data, indent=2) + "\n")
    print(" ", name, "→", ver)
PY

printf '%s\n' "$BUILD_ID" > /tmp/FORCE_BUILD.txt
rm -f "$OUT"
(
  cd "$ROOT"
  zip -9 -r "$OUT" \
    index.html manifest.webapp manifest.webmanifest \
    js/core.js js/bridge.js js/storage.js \
    icons/icon-56.png icons/icon-112.png icons/icon-512.png
)
(cd /tmp && zip -9 "$OUT" FORCE_BUILD.txt)
ls -la "$OUT"

$ADB get-state >/dev/null
echo "==> device $($ADB get-serialno)"

$ADB push "$OUT" /data/local/tmp/bmud-deploy.zip
$ADB shell 'appscmd install /data/local/tmp/bmud-deploy.zip'
$ADB shell "su -c 'cd /data/local/webapps/installed/bmudtools && unzip -o application.zip && chmod -R a+r . && cat FORCE_BUILD.txt'"

MAIN=$($ADB shell "su -c 'ps -A'" | awk '$1=="root" && $NF=="b2g" && $3=="1" {print $2; exit}' | tr -d '\r')
if [ -n "${MAIN:-}" ]; then
  echo "==> restart b2g pid $MAIN"
  $ADB shell "su -c 'kill -KILL $MAIN'" || true
else
  echo "==> b2g pid not found (app still installed; reopen manually)"
fi
sleep 3
echo "==> done. Reopen B-Mud on the phone. build=$BUILD_ID version=$VERSION"
