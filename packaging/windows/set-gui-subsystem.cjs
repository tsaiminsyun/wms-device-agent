// 把 Windows exe 的 PE Subsystem 從 CONSOLE(3) 改為 GUI(2)：
// 雙擊啟動不再閃任何主控台視窗（需求：啟動完全無視窗，只有系統匣圖示）。
// stdout/stderr 重導與 log 寫檔不受影響。用法：node set-gui-subsystem.cjs <exe路徑>
"use strict";
const fs = require("node:fs");

const GUI = 2;
const CONSOLE = 3;

const path = process.argv[2];
if (!path) {
  console.error("用法：node set-gui-subsystem.cjs <exe路徑>");
  process.exit(1);
}
const buf = fs.readFileSync(path);
if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error("不是 MZ 執行檔");
const peOffset = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOffset) !== 0x00004550) throw new Error("找不到 PE 簽章");
const magic = buf.readUInt16LE(peOffset + 24);
if (magic !== 0x10b && magic !== 0x20b) throw new Error(`未知的 Optional Header magic：0x${magic.toString(16)}`);
// Subsystem 欄位在 Optional Header 偏移 68（PE32 與 PE32+ 相同）。
const subsystemOffset = peOffset + 24 + 68;
const current = buf.readUInt16LE(subsystemOffset);
if (current === GUI) {
  console.log(`Subsystem 已是 GUI(2)：${path}`);
  process.exit(0);
}
if (current !== CONSOLE) throw new Error(`非預期的 Subsystem 值：${current}（預期 CONSOLE=3）`);
buf.writeUInt16LE(GUI, subsystemOffset);
fs.writeFileSync(path, buf);
console.log(`Subsystem CONSOLE(3) → GUI(2)：${path}`);
