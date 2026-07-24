#!/usr/bin/env bash
# 打包 wms-device-agent 的「安裝程式酬載（payload）」：Windows x64 單一執行檔（Node SEA）
# ＋原生相依 node_modules ＋設定/啟動腳本，全部組裝進 dist-win/wms-device-agent/。
# 可在 macOS / Linux / CI 執行（原生模組以 prebuilt 跨平台取得，不需編譯）。
#
# 這個資料夾就是 Inno Setup 的酬載來源：接著在 Windows/CI 上用 ISCC 編譯
# packaging/windows/wms-device-agent.iss 產生 setup.exe（見該檔頭註解與 CI workflow）。
# 注意：SEA blob 與 node.exe 版本綁定，兩者必須同版。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# 優先用 mise 釘選的 node（與 mise.toml 一致）；可用 NODE_BIN 覆寫。
NODE_BIN="${NODE_BIN:-$(mise which node 2>/dev/null || command -v node)}"
NPM_CLI="$(dirname "$NODE_BIN")/npm"
[ -x "$NPM_CLI" ] || NPM_CLI="npm"

NODE_VERSION="$("$NODE_BIN" --version)"
PKG_NAME="$("$NODE_BIN" -p "require('./package.json').name")"
PKG_VERSION="$("$NODE_BIN" -p "require('./package.json').version")"

BUILD="$ROOT/build"
DIST_ROOT="$ROOT/dist-win"
# 「安裝程式建置包（kit）」：zip 內的單一頂層資料夾，含 wms-device-agent.iss 與 payload/。
# 在 Windows 上解壓後直接 `ISCC wms-device-agent.iss` 即可產生 setup.exe。
KIT_NAME="wms-device-agent-installer"
KIT="$DIST_ROOT/$KIT_NAME"
DIST="$KIT/payload"     # 安裝時實際安裝的檔案（exe / node_modules / config / 腳本 / 文件）組裝於此
CACHE="$ROOT/packaging/.cache"
WIN_DIR="$ROOT/packaging/windows"

rm -rf "$BUILD" "$DIST_ROOT"
mkdir -p "$BUILD" "$DIST" "$CACHE"

echo "==> [1/6] esbuild：bundle app → build/agent.cjs（Node ${NODE_VERSION}）"
# bufferutil/utf-8-validate 缺席時 ws 自動退回純 JS；__PKG_META__ 與 import.meta.url 於編譯期注入。
pnpm exec esbuild src/index.ts \
  --bundle --platform=node --format=cjs --target=node22 \
  --outfile="$BUILD/agent.cjs" \
  --external:bufferutil --external:utf-8-validate \
  --define:__PKG_META__="{\"name\":\"${PKG_NAME}\",\"version\":\"${PKG_VERSION}\"}" \
  --define:import.meta.url=__IMPORT_META_URL__ \
  --banner:js="const __IMPORT_META_URL__ = require('node:url').pathToFileURL(__filename).href;" \
  --log-level=warning

echo "==> [2/6] 產生 SEA blob"
cat > "$BUILD/sea-config.json" <<JSON
{
  "main": "build/agent.cjs",
  "output": "build/sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
JSON
"$NODE_BIN" --experimental-sea-config "$BUILD/sea-config.json"

echo "==> [3/6] 取得官方 Windows node.exe（${NODE_VERSION}，快取：packaging/.cache）"
ZIP="node-${NODE_VERSION}-win-x64.zip"
if [ ! -f "$CACHE/$ZIP" ]; then
  curl -fL --retry 3 "https://nodejs.org/dist/${NODE_VERSION}/$ZIP" -o "$CACHE/$ZIP.tmp"
  mv "$CACHE/$ZIP.tmp" "$CACHE/$ZIP"
fi
unzip -jo "$CACHE/$ZIP" "node-${NODE_VERSION}-win-x64/node.exe" -d "$BUILD" > /dev/null

echo "==> [4/6] postject：把 blob 注入 exe"
cp "$BUILD/node.exe" "$DIST/wms-device-agent.exe"
pnpm exec postject "$DIST/wms-device-agent.exe" NODE_SEA_BLOB "$BUILD/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

echo "==> [5/6] npm：安裝 Windows 版原生相依（--os=win32 --cpu=x64）"
NATIVE="$WIN_DIR/native-deps"
rm -rf "$NATIVE/node_modules"
(cd "$NATIVE" && "$NPM_CLI" install \
  --os=win32 --cpu=x64 \
  --ignore-scripts --no-audit --no-fund --no-package-lock --loglevel=error)
cp -R "$NATIVE/node_modules" "$DIST/node_modules"

# 瘦身：移除非 win32-x64 平台的原生二進位（npm 會把所有平台的 prebuilds/選用平台包都裝進來）。
rm -rf "$DIST/node_modules/@nut-tree-fork/libnut-darwin" "$DIST/node_modules/@nut-tree-fork/libnut-linux"
find "$DIST/node_modules/@serialport/bindings-cpp/prebuilds" -mindepth 1 -maxdepth 1 -type d ! -name "win32-x64" -exec rm -rf {} +
find "$DIST/node_modules/node-hid/prebuilds" -mindepth 1 -maxdepth 1 -type d ! -name "*win32-x64*" -exec rm -rf {} +
# systray2 的工作列 helper：只留 Windows 版。
rm -f "$DIST/node_modules/systray2/traybin/tray_darwin_release" "$DIST/node_modules/systray2/traybin/tray_linux_release"

# 驗證關鍵 Windows 原生二進位確實在包裡（缺了代表跨平台安裝失敗，直接中止）。
check() {
  if ! ls $1 > /dev/null 2>&1; then
    echo "!! 缺少 Windows 原生二進位：$1" >&2
    exit 1
  fi
}
check "$DIST/node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/*.node"
check "$DIST/node_modules/node-hid/prebuilds/HID-win32-x64/*.node"
check "$DIST/node_modules/@nut-tree-fork/libnut-win32/build/Release/*.node"
check "$DIST/node_modules/systray2/traybin/tray_windows_release.exe"

echo "==> [6/6] 組裝安裝程式建置包（.iss + payload/）"
# payload/：安裝時實際安裝的檔案。安裝、解除安裝、更新、開機自動啟動改由 Inno setup.exe
# 負責，故不再隨附 install-autostart / uninstall-autostart / update-agent 那些 .bat。
cp "$ROOT/config.example.json" "$DIST/config.json"
# 只帶「開機自動啟動排程工作」實際會用到的兩支 helper；不再隨附說明文件與手動啟動 .bat
# （改為只發佈 setup.exe，使用者不需開啟安裝資料夾）。
cp "$WIN_DIR/run-agent.bat" "$WIN_DIR/run-hidden.vbs" "$DIST/"

# 把 .iss 放到 kit 頂層，前面先寫 UTF-8 BOM（.iss 含中文 DestName，Inno 需 BOM 才正確解讀），
# 再注入本次版本號（#ifndef 會保留這個值）。於是在 Windows/Docker 上只要 `ISCC wms-device-agent.iss`
# （零參數）即可編譯：版本已內建、payload 就在隔壁。
{ printf '\357\273\277'; echo "#define AppVersion \"${PKG_VERSION}\""; cat "$WIN_DIR/wms-device-agent.iss"; } > "$KIT/wms-device-agent.iss"

# kit 資料夾（dist-win/）就是 compile-installer.sh 的編譯來源，平時不需壓成 zip。
# 只有「拿到 Windows 用原生 ISCC 自己編」那條路才需要可攜的 zip——由 WMS_KIT_ZIP=1 觸發
# （pnpm package:win:kit）。package:win 走 Docker 直接讀資料夾，不產這個 zip。
if [ "${WMS_KIT_ZIP:-0}" = "1" ]; then
  OUT_ZIP="$ROOT/${KIT_NAME}-${PKG_VERSION}.zip"
  rm -f "${OUT_ZIP}"
  # payload 內全為 ASCII 檔名，普通 zip 即可（不再需要 UTF-8 檔名特別處理）。
  (cd "$DIST_ROOT" && zip -qr "${OUT_ZIP}" "$KIT_NAME")
  echo ""
  echo "完成（可攜的安裝程式建置 kit）："
  echo "  壓縮檔：${OUT_ZIP}（$(du -h "${OUT_ZIP}" | cut -f1 | tr -d ' ')）"
  echo "  在 Windows 上：解壓 → 進入 ${KIT_NAME}\\ 執行 ISCC wms-device-agent.iss → Output\\ 得 setup.exe"
else
  echo ""
  echo "完成（kit 資料夾，待編譯）：${KIT}"
  echo "  （由 compile-installer.sh 用 Docker 編成 setup.exe；或設 WMS_KIT_ZIP=1 產可攜 zip。）"
fi
