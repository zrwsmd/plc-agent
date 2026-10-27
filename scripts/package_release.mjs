/**
 * 发布打包：把 readme.md 临时挪开，跑 vsce，再挪回来，最后统一产物名。
 *
 * 为什么不能只写 .vscodeignore：vsce 会把 README 强制打进包，里面写
 * `readme.md` 或 `README.md` 都不生效（两种都实测过，`vsce ls` 照样列出来）。
 * 而这份 readme 里有整节「架构」把 src 每个文件的职责列全了，还写出了 webview
 * 的消息协议和工具审批表 —— 那正是 bundle 里花力气藏起来的东西，留着等于白藏。
 *
 * 挪动放在 .release-hold/（同盘 rename，原子），该目录已写进 .vscodeignore，
 * 万一它被打进包也不会被漏掉。无论成功失败都在 finally 里挪回来。
 *
 * 用法: npm run package
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const README = 'readme.md';
const HOLD_DIR = '.release-hold';
const HOLD = path.join(HOLD_DIR, README);
const OUT = 'plc-agent.vsix';

// 上一次打包中途被打断，readme 还躺在暂存目录里，先挪回来再继续
if (!fs.existsSync(README) && fs.existsSync(HOLD)) {
  fs.renameSync(HOLD, README);
  fs.rmSync(HOLD_DIR, { recursive: true, force: true });
  console.log('[package] 恢复上次遗留的 readme.md');
}

let moved = false;
try {
  if (fs.existsSync(README)) {
    fs.mkdirSync(HOLD_DIR, { recursive: true });
    fs.renameSync(README, HOLD);
    moved = true;
  }
  execFileSync('npx', ['@vscode/vsce', 'package', '--allow-missing-repository'], {
    stdio: 'inherit',
    shell: true,
  });
} finally {
  if (moved) {
    fs.renameSync(HOLD, README);
    fs.rmSync(HOLD_DIR, { recursive: true, force: true });
  }
}

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const built = `plc-agent-vscode-${version}.vsix`;
if (!fs.existsSync(built)) {
  console.error(`[package] 没找到 ${built}`);
  process.exit(1);
}
fs.renameSync(built, OUT);
console.log(`[package] ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)}KB)`);
