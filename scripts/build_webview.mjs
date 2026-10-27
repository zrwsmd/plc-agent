/**
 * webview 前端的发布构建：把 media/main.js 包进一个函数作用域再混淆，
 * 把 media/main.css 去掉注释和空白。产物落在 media/bundle/。
 *
 * 为什么必须包一层：media/main.js 是普通脚本，277 个函数全挂在全局作用域。
 * 混淆器开着 renameGlobals:false（这个开关不能关，主进程 bundle 靠它保住
 * 顶层声明），而它对脚本的全局声明一律不动 —— 直接混淆等于一个字没改。
 * 包成函数作用域之后，这些名字变成局部变量，才会被改名。
 *
 * 包裹是安全的，已逐项确认：文件里没有顶层 this、没有顶层 return、
 * 没有 import/export、没有字符串形式的 setTimeout、没有 eval / new Function、
 * 没有内联事件属性、没有 el.onclick = 这种赋值，也没有 arguments.callee。
 * 所有 .name 的用法都是数据字段（vendor.name、server.name），不是函数名。
 *
 * 开发宿主不读这里：chatView 在 Development 模式下直接加载 media/ 下的源码，
 * 所以 F5 调试不需要先跑一遍混淆。
 *
 * 用法:
 *   node scripts/build_webview.mjs           发布构建（混淆 + 压缩）
 *   node scripts/build_webview.mjs --debug   只包裹，不混淆不压缩，便于排查
 */
import fs from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { OPTIONS } from './obfuscate_release.mjs';

const SRC_JS = 'media/main.js';
const SRC_CSS = 'media/main.css';
const OUT_DIR = 'media/bundle';

const debug = process.argv.includes('--debug');

for (const file of [SRC_JS, SRC_CSS]) {
  if (!fs.existsSync(file)) {
    console.error(`[webview] 缺少 ${file}`);
    process.exit(1);
  }
}

const source = fs.readFileSync(SRC_JS, 'utf8');
const wrapped = `(function () {\n${source}\n})();\n`;

const startedAt = Date.now();
const outJs = debug
  ? wrapped
  : JavaScriptObfuscator.obfuscate(wrapped, OPTIONS).getObfuscatedCode();

const css = fs.readFileSync(SRC_CSS, 'utf8');
const outCss = debug ? css : (await transform(css, { loader: 'css', minify: true })).code;

// 混淆产物语法自检：new Function 只解析不执行，坏了在构建期就炸，
// 不会等到装进编辑器、webview 白屏才发现。
try {
  new Function(outJs);
} catch (error) {
  console.error(`[webview] 产物语法错误: ${error.message}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'main.js'), outJs, 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'main.css'), outCss, 'utf8');

const kb = (bytes) => `${Math.round(bytes / 1024)}KB`;
console.log(
  `[webview] ${debug ? 'debug' : 'release'} main.js ${kb(source.length)} -> ${kb(outJs.length)}, ` +
    `main.css ${kb(css.length)} -> ${kb(outCss.length)}, ${Date.now() - startedAt}ms`,
);
