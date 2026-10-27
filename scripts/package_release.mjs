/**
 * 发布打包：构建 → 把 readme 和 package.json 里的开发信息摘掉 → 跑 vsce → 还原。
 *
 * 三样东西不能进包，原因各不相同：
 *  - readme.md 里有一整节「架构」把 src 每个文件的职责列全，还写出了 webview
 *    消息协议和工具审批表 —— 正是 bundle 里花力气藏起来的东西。
 *    vsce 会强制把 README 打进包，.vscodeignore 里写 `readme.md` 或 `README.md`
 *    都不生效（两种都实测过），所以只能打包时把文件挪走。
 *  - package.json 的 scripts 有 15 条带着测试文件名，等于一份模块清单。
 *  - package.json 的 devDependencies 明写着 javascript-obfuscator 和 esbuild，
 *    dependencies 又把四个 LLM SDK 列了一遍（它们在 bundle 里本来已经看不见了）。
 *
 * 摘字段的顺序有讲究：先自己跑完 vscode:prepublish，再摘 scripts。
 * 反过来不行 —— vsce 是靠 `npm run vscode:prepublish` 触发构建的，
 * 字段摘了它就找不到这个脚本，构建直接不跑。
 *
 * 所有改动都备份在 .release-hold/（已写进 .vscodeignore），并在 finally 里还原；
 * 开头还带自愈：上次中途被打断就把残留的备份挪回去。
 *
 * 用法: npm run package
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const README = 'readme.md';
const HOLD_DIR = '.release-hold';
const HOLD_README = path.join(HOLD_DIR, README);
const HOLD_PKG = path.join(HOLD_DIR, 'package.json');
const OUT = 'plc-agent.vsix';
const DROP_FIELDS = ['scripts', 'dependencies', 'devDependencies'];

const run = (command, args) =>
  execFileSync(command, args, { stdio: 'inherit', shell: true });

// ---- 自愈：上次打包中途被打断 ----
if (fs.existsSync(HOLD_PKG)) {
  fs.copyFileSync(HOLD_PKG, 'package.json');
  fs.rmSync(HOLD_PKG);
  console.log('[package] 恢复上次遗留的 package.json');
}
if (!fs.existsSync(README) && fs.existsSync(HOLD_README)) {
  fs.renameSync(HOLD_README, README);
  console.log('[package] 恢复上次遗留的 readme.md');
}

const originalPkg = fs.readFileSync('package.json', 'utf8');
const pkg = JSON.parse(originalPkg);
const dropped = DROP_FIELDS.filter((key) => key in pkg);
for (const key of dropped) delete pkg[key];
const strippedPkg = JSON.stringify(pkg, null, 2) + '\n';

let patched = false;
let movedReadme = false;

try {
  // 1. 构建：必须赶在摘 scripts 之前，否则 vsce 找不到 vscode:prepublish
  run('npm', ['run', 'vscode:prepublish']);

  // 2. 摘开发信息（先落备份，再改）
  fs.mkdirSync(HOLD_DIR, { recursive: true });
  fs.writeFileSync(HOLD_PKG, originalPkg, 'utf8');
  fs.writeFileSync('package.json', strippedPkg, 'utf8');
  patched = true;

  // 3. readme 挪开
  if (fs.existsSync(README)) {
    fs.renameSync(README, HOLD_README);
    movedReadme = true;
  }

  // 4. 打包（此时 package.json 里没有 scripts，vsce 不会再触发一次构建）
  run('npx', ['@vscode/vsce', 'package', '--allow-missing-repository']);
} finally {
  if (movedReadme) fs.renameSync(HOLD_README, README);
  if (patched) fs.writeFileSync('package.json', originalPkg, 'utf8');
  fs.rmSync(HOLD_DIR, { recursive: true, force: true });
}

const built = `plc-agent-vscode-${pkg.version}.vsix`;
if (!fs.existsSync(built)) {
  console.error(`[package] 没找到 ${built}`);
  process.exit(1);
}
fs.renameSync(built, OUT);
console.log(
  `[package] ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)}KB) ` +
    `已摘除 ${dropped.join(' / ')}`,
);
