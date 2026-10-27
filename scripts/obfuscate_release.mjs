/**
 * 发布构建的最后一步:把 bundle 里的字符串收进数组并编码。
 *
 * 目的只有一个:让拿到安装包的人不能靠 grep 直接捞出工具名、参数名和提示词。
 * 混淆之后,`devuni_create_project` 这种字面量不再以明文出现,要先找到字符串数组
 * 再解开才能读到。
 *
 * 刻意关掉的东西,以及为什么:
 * - controlFlowFlattening / deadCodeInjection:对 3MB 的 bundle 会跑很久,输出膨胀
 *   几倍,而且一旦出问题是那种"能启动但某条分支算错"的隐性故障。这是唯一会真正
 *   改坏逻辑的一组开关,不碰。
 * - renameProperties / transformObjectKeys:工具名、协议字段、zod schema 的键都是
 *   对象属性,改名会直接破坏模型调用和 JSON 往返。
 * - selfDefending / debugProtection:会在代码里埋自毁逻辑,和调试、错误上报冲突。
 * - splitStrings:字符串已经全部进了编码数组,再切碎只是让数组变长几倍,不多挡一层。
 * - renameGlobals:保留顶层声明名。esbuild 的 --keep-names 会在类里插
 *   `static { 辅助函数(this, "AgentsError") }`(辅助函数在压缩后名字被缩短,
 *   所以 grep `__name` 是 0 处),这条语句靠的是"名字"这个参数,不是声明名,
 *   声明名让不让改都不影响它。
 *
 * 标识符重命名只作用于局部变量,`new.target.name` 那类判断不受影响 —— 已用
 * @openai/agents-core 的 AgentsError、@anthropic-ai/sdk 的 APIUserAbortError
 * 实测过:混淆前后 name 都是 AgentsError / Error,instanceof 也都成立。
 *
 * 产物先写临时文件再原子替换,混淆中途失败不会留下半截 bundle。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const TARGET = path.resolve('dist/extension.js');

export const OPTIONS = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: false,
  renameGlobals: false,
  renameProperties: false,
  selfDefending: false,
  simplify: false,
  splitStrings: false,
  stringArray: true,
  stringArrayCallsTransform: false,
  stringArrayEncoding: ['rc4'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 1,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!fs.existsSync(TARGET)) {
    console.error('[obfuscate] 缺少 dist/extension.js,先跑 npm run compile');
    process.exit(1);
  }

  const source = fs.readFileSync(TARGET, 'utf8');
  const startedAt = Date.now();
  const result = JavaScriptObfuscator.obfuscate(source, OPTIONS);
  const output = result.getObfuscatedCode();

  const temp = `${TARGET}.tmp`;
  fs.writeFileSync(temp, output, 'utf8');
  fs.renameSync(temp, TARGET);

  const kb = (bytes) => `${Math.round(bytes / 1024)}KB`;
  console.log(
    `[obfuscate] ${kb(source.length)} -> ${kb(output.length)} in ${Date.now() - startedAt}ms`,
  );
}
