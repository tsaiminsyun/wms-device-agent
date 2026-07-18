#!/usr/bin/env bash
# 打包 wms-device-agent 為 Windows x64 單一執行檔（Node SEA）＋原生相依 node_modules，
# 產物在 dist-win/ 並壓成 zip。可在 macOS / Linux / CI 執行；內容說明見 README-WINDOWS.md。
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
PKG_DIR="${PKG_NAME}"   # 解壓後的單一頂層資料夾名
DIST="$DIST_ROOT/$PKG_DIR"                      # 所有檔案組裝進此資料夾（zip 內即以此為頂層）
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

echo "==> [4/6] postject：把 blob 注入 exe，並把 PE Subsystem 改為 GUI（雙擊不開任何視窗）"
cp "$BUILD/node.exe" "$DIST/wms-device-agent.exe"
pnpm exec postject "$DIST/wms-device-agent.exe" NODE_SEA_BLOB "$BUILD/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
"$NODE_BIN" "$WIN_DIR/set-gui-subsystem.cjs" "$DIST/wms-device-agent.exe"

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
check "$DIST/node_modules/node-windows/package.json"

echo "==> [6/6] 組裝發佈資料夾與 zip"
cp "$ROOT/config.example.json" "$DIST/config.json"
cp "$WIN_DIR/start-agent.bat" "$WIN_DIR/run-agent.bat" \
   "$WIN_DIR/install-autostart.bat" "$WIN_DIR/uninstall-autostart.bat" "$WIN_DIR/update-agent.bat" \
   "$WIN_DIR/run-hidden.vbs" "$WIN_DIR/run-tray-hidden.vbs" "$WIN_DIR/service-entry.cjs" \
   "$WIN_DIR/README-WINDOWS.md" "$DIST/"

OUT_ZIP="$ROOT/${PKG_DIR}.zip"
rm -f "${OUT_ZIP}"
# 從 dist-win 打包整個 $PKG_DIR 資料夾 → 壓縮檔內含「單一頂層資料夾」，
# 使用者解壓即得一個資料夾（不會把檔案散落在桌面／下載夾）。
(cd "$DIST_ROOT" && zip -qr "${OUT_ZIP}" "$PKG_DIR")

echo ""
echo "完成："
echo "  資料夾：${DIST}"
echo "  壓縮檔：${OUT_ZIP}（$(du -h "${OUT_ZIP}" | cut -f1 | tr -d ' ')；解壓為單一資料夾 ${PKG_DIR}/）"
echo "  exe   ：$(du -h "$DIST/wms-device-agent.exe" | cut -f1 | tr -d ' ')（Node ${NODE_VERSION} win-x64 + app bundle）"
echo ""
echo "安裝程式（Windows 服務版）：於 Windows 以 Inno Setup 6 編譯——"
echo "  iscc /DMyAppVersion=${PKG_VERSION} packaging\\windows\\installer.iss"
echo "  產出 dist-win/wms-device-agent-setup.exe（自動註冊服務＋工作列元件自啟動）"
