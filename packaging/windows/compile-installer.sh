#!/usr/bin/env bash
# 直接把安裝程式建置包（kit）編成 setup.exe，再壓成要發佈的 zip——在 macOS/Linux 上用 Docker
# 影像 amake/innosetup（內含 Wine + Inno Setup）跑 ISCC，本機不需安裝 Wine 或 Inno Setup。
#
# 先決條件：已跑過 build-win.sh（pnpm package:win）產生
#   dist-win/wms-device-agent-installer/（含 wms-device-agent.iss 與 payload/）。
# 用法：bash packaging/windows/compile-installer.sh   （或 pnpm package:win:exe 一次做完）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT="$ROOT/dist-win/wms-device-agent-installer"
IMAGE="${INNOSETUP_IMAGE:-amake/innosetup:latest}"

if [ ! -f "$KIT/wms-device-agent.iss" ]; then
  echo "!! 找不到 $KIT/wms-device-agent.iss" >&2
  echo "   請先執行： pnpm package:win" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "!! 需要 Docker（未偵測到 docker 指令）。請先安裝／啟動 Docker Desktop。" >&2
  exit 1
fi

echo "==> 用 Docker 影像 ${IMAGE} 編譯安裝程式（首次會先下載影像，約數百 MB）…"
# 影像的 workdir=/work、entrypoint=iscc；掛載 kit 後對 wms-device-agent.iss 編譯。
# .iss 已內建版本號、PayloadDir=payload，故零參數即可；產物落在 /work/Output（即主機的 $KIT/Output）。
docker run --rm -v "$KIT:/work" "$IMAGE" wms-device-agent.iss

EXE="$(ls "$KIT"/Output/*.exe 2>/dev/null | head -1 || true)"
if [ -z "$EXE" ]; then
  echo "!! 編譯未產生 setup.exe，請看上方 ISCC 輸出。" >&2
  exit 1
fi

# 成品壓成 zip 放到專案根目錄，就是唯一要發佈的檔案。壓 zip 是因為 email／雲端硬碟／防毒
# 常直接攔截裸 .exe 附件；zip 內就是單一支 setup.exe（-j 去掉路徑，解壓即見）。
BASENAME="$(basename "$EXE")"                 # wms-device-agent-setup-<版本>.exe
OUT_ZIP="$ROOT/${BASENAME%.exe}.zip"          # wms-device-agent-setup-<版本>.zip
rm -f "$OUT_ZIP" "$ROOT/$BASENAME"            # 一併清掉舊版流程留在根目錄的裸 exe，避免誤傳舊檔
(cd "$(dirname "$EXE")" && zip -qj "$OUT_ZIP" "$BASENAME")

echo ""
echo "完成（要發佈給使用者的安裝程式）："
echo "  ★ ${OUT_ZIP}（$(du -h "$OUT_ZIP" | cut -f1 | tr -d ' ')）"
echo "  內含：${BASENAME}"
echo "  使用者解壓縮後雙擊 setup.exe 即可安裝，不需 Node、不需 Inno Setup、不需其他工具。"
