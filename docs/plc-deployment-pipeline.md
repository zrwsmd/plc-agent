# PLC 应用下游链路：从编译到设备上跑起来

这份文档描述的是 ST 代码写好之后，到工控机上真正跑起来之间发生的事情。内容来自已安装的 IDE 扩展 `ytak.devuni-ide-vscode-1.0.21`（`out/` 目录下未混淆的编译产物），不是推测。

对应关系先摆清楚：本文讲的是 devuni IDE 里那套"编译-部署-运行"链路。我们自己的 agent 目前只走到"ST 落盘"，下游这一段还没接。

---

## 一、先对齐几个词

### 设备（device）

指目标工控机，不是跑 IDE 的那台 PC。

证据在 `out/_cDevModel.js` 里，注释写得很直白：

```js
let sc5100Serial = 'SC5100'; /**工控机（primary device）SC5100的型号 */
```

目前定义了两个型号：

| 型号 | 定位 | 总线 |
| --- | --- | --- |
| `SC5100` | 工控机，主设备 | 一个网口，跑 EtherCAT 主站 |
| `SNK-3568-E4CS2I8O8` | 带本地 IO 的嵌入式控制器 | com0、网口 0-3、CAN0-1，支持 Modbus TCP 主站、CANopen |

交叉编译工具链是 `gcc-arm-10.3-aarch64-none-linux-gnu`，产物是 ARM64 的 `.so`。所以设备是跑 Linux 的 ARM 工控机，不是 x86 PC。

一个工程里只能有一个设备节点，代码里多处硬校验：

```js
if (subs.length === 0) { 报错 '工程中没有设备节点' }
else if (subs.length > 1) { 报错 '工程中不能有多个设备节点' }
```

设备下面挂的是 EtherCAT 从站、扩展模块、轴、HMI 这些，它们不是"设备"，是设备的下游节点。

### 运行时（runtime）

设备上那个负责加载并执行 IEC 应用的进程。IDE 只跟它通信，不直接操作设备上的文件。所有部署、运行、变量读写的动作，都是发给 runtime 的报文。

### 登录

不是账号登录。在这套体系里，登录 = 把编译好的应用部署到设备上、让 runtime 把它加载起来、建立在线连接。对应 CODESYS 语境的 Login。

界面上"连接 → 登录 → 运行"三个状态是分开的，代码里也是三个独立命令。

### 三件套

编译成功后必须存在的三个文件，缺一个就抛 `compile artifacts missing`：

- `project/build/Application.so` —— 编译出来的应用本体
- `project/build/Application.data` —— 应用数据段
- `project/build/VARIABLES_DEBUG.csv` —— 可订阅变量清单，运行后建变量池、做监视和跟踪都靠它

另外还有一个 `plc_config.json`，是设备组态（设备树、从站列表、IO 映射），登录时要一起送过去。

---

## 二、整体顺序

```
连接设备 connectRuntime
      ↓
  编译 compilePlcApp          ← 可以单独点，登录时也会自动补
      ↓
  登录 installRuntime          ← 部署 + 加载，需要已连接
      ↓
  运行 runApp
      ↓
  跟踪 launchTraceToRuntime    ← 需要应用正在运行
      ↓
  停止 stopApp
      ↓
退出登录 deinstallRuntime
      ↓
  断开 disconnectRuntime
```

有两个顺序约束是硬性的，不是建议：

- 登录必须在连接之后。`sendPackageToDev` 用的是已建立的 socket，没连接就没地方发。
- 运行必须在登录之后。`run()` 开头就检查部署状态是不是 `DEPS_READY`，不是就抛"登录未就绪，此时不能运行应用"。

---

## 三、逐步展开

### 3.1 连接设备 `devUni.prjView.connectRuntime`

做什么：跟设备的 runtime 建立一条 TCP 长连接。

输入：设备 IP。先弹历史 IP 列表让用户选，选"手动输入"就弹输入框。选过的 IP 会记进 globalState，下次直接出现在列表里。

内部：`net.createConnection(57165, ip)`。端口是 `0xdf4d`，代码注释写的是"与设备端使用的端口"。连上之后有心跳保活（`linkKeep` 喂狗），断了会自动走异常断开流程。

成功之后：把 IDE 上下文切成 `readyLogin=true`、`connect=false`，也就是界面上"登录"按钮亮起来。

失败长什么样：抛 `连接失败: <原因>`，附带 detail "请确认设备连接是否正确"。

注意：这个命令内部还做了并发保护——正在连接时再点会抛"正在连接"，已连接时再点会抛"已经有设备连接"。

### 3.2 编译 `devUni.prjView.compilePlcApp`

做什么：把工程里的 ST 源码、库、设备组态、HMI 配置一起塞进 `.depworkspace`，调外部工具链编出 `.so`。

前置：必须打开了 `.code-workspace`（它用 `vscode.workspace.workspaceFile` 取工程名），必须有且只有一个设备节点。

具体步骤（`_cSubProject.compilePlcApp`）：

1. 建编译目录 `tool/iec-runtime-gen-run/.depworkspace`，每次整个重建。
2. 生成 `plc_config.json`：设备树拆成 `slaves_list`，每个从站补 `device_global_name`、`device_index`、`master_index`。轴池节点会删掉 `config_file`、`parent_index`、`subDevices`。
3. 生成 `gloval_var.global.st`：轴相关的全局变量（注意文件名里那个拼写错误，就是 `gloval`）。
4. `copyStFilesForCompile`：拷工作区根目录顶层的 `.st`。子目录里的会被静默跳过。
5. `copyCompileSourceFiles`：拷库源码。
6. 生成 HMI 配置 `plc_hmi_runtime.json`（有 HMI 节点时）。
7. 起 `start.exe -i <compDir>`，cwd 也是 compDir，超时 300 秒。
8. 断言三件套存在，算 `Application.so` 和 `Application.data` 的 md5，写 `.depworkspace/compileHash`。

`start.exe` 里面串的是 matiec（IEC 61131-3 转 C）+ gcc-arm 交叉编译，同目录下能看到 `matiec`、`gcc-arm-10.3-aarch64-none-linux-gnu`、`accuplc-proto`。

失败长什么样：弹"编译失败"，日志在 `tool/iec-runtime-gen-run/log/`。

### 3.3 登录 `devUni.prjView.installRuntime`

做什么：把编译产物打包送到设备，让 runtime 加载起来。这一步最容易和"编译"混，其实它内部会先判断要不要重编。

前置判断（这就是为什么有时候点登录不重新编译）：

1. 如果从来没有编译过 → 直接编译。
2. 如果有上次的编译记录，依次比三样：
   - ST 文件内容有没有变（`compareStFile`）
   - `.depworkspace` 里各文件的 md5 有没有变（`compareCfgMd5`，对照 `compileHash`）
   - `plc_config.json` 有没有变（`comparePlcCfg`）
   
   三样都没变就直接用上次的产物，一样变了就重编。

真正的部署动作：

1. 校验四样东西都在：`Application.so`、`Application.data`、`VARIABLES_DEBUG.csv`、`plc_config.json`。
2. 把 `plc_config.json` 读成组态对象，检查合法性。
3. 用 `VARIABLES_DEBUG.csv` 建变量池（`generateSubVarPool`），这是后面监视和跟踪的数据源。
4. 用系统 `tar.exe` 把整个编译目录打成 tar 包。
5. 发 `sendPackageToDev(tar, isPersist, soMd5, dataMd5)`，等设备回执。
6. 状态切到 `DEPS_READY`，删掉临时 tar。

这里有个必须让用户选的选项：部署模式。

- 临时部署（`isPersist=false`）：设备重启后应用不保留。
- 持久部署（`isPersist=true`）：设备重启后自动启动。

登录成功之后 IDE 会把类型文件锁成只读（`lockStatus=true`），运行期间不允许改工程，连"打开设置"都会弹"运行过程中无法进行编辑"。要改代码得先停运行、退出登录。

失败长什么样：抛具体原因（"发送package失败"、"部署包路径无效"、"订阅变量路径无效"、"组态文件路径无效"），或者部署超时。

### 3.4 运行 `devUni.prjView.runApp`

做什么：让 runtime 启动 IEC 应用。

前置检查（一长串，任一不满足就抛）：

- 已连接
- 不在断开中
- 不在退出登录中
- 部署状态是 `DEPS_READY`
- 不在启动中、不在停止中
- 应用状态不是 `APPS_NO`

如果应用状态是"已暂停/已运行"之类非 `APPS_READY` 的，它会先 `stop()` 再启动。

内部：发运行报文，然后等状态变成 `APPS_RUN`，超时 5 秒。超时抛"启动应用超时！！！"。

成功之后：界面开始做两件持续的事——按 250ms 周期刷新任务运行状态，以及建立 HMI 数据面连接（如果工程里有 HMI 节点）。

### 3.5 跟踪 `devUni.prjView.launchTraceToRuntime`

做什么：在运行中的应用上订阅指定变量，按任务周期采样，形成波形/曲线。

前置：应用必须正在运行（`isAppRun()`），工程里必须有 Trace 节点，节点上必须配了任务名和至少一个数据通道。

内部：把 Trace 节点上的数据通道转成 `bindings`（变量路径 + 任务名 + 订阅者），调 `createVariableSubscription`，拿一个 `dispatchId`。订阅失败会触发 `onFault`，然后自动停掉这条 Trace 并报错。

另外还有 `launchTraceV2ToRuntime`，是同一件事的新版本实现。停止用 `StopTraceToRuntime` / `StopTraceV2ToRuntime`。

### 3.6 收尾

- `devUni.prjView.runPrj` / `stopApp`：停应用。停完可以改代码。
- `devUni.prjView.deinstallRuntime`：退出登录，把设备上的应用卸掉，解除只读锁定。
- `devUni.prjView.disconnectRuntime`：断开 TCP。断开前会先停掉所有 Trace。
- `devUni.prjView.exceptionDisconnectRuntime`：异常断线的善后，清理呼吸动画、装饰器、只读状态，把上下文恢复成"可登录"。

---

## 四、通信与状态机

- 传输：裸 TCP，不是 gRPC。`net.createConnection(57165, ip)`。`accuplc-proto/` 下的 `.proto` 只描述报文结构（`ProtoTask`、`ProtoApplication`、`PbBaseDevice` 等），没有用 gRPC 框架。
- 保活：心跳计数，代码里叫"喂狗"。
- 部署包：系统 `tar.exe` 打的 tar，附带 `soMd5`、`dataMd5`，设备侧可以据此判断要不要真的更新。
- 状态机有两套：部署状态（`DEPS_NO` → `DEPS_EMPY` → `DEPS_READY` / `DEPS_ERR`）和应用运行状态（`APPS_NO` / `APPS_READY` / `APPS_RUN` / `APPS_PAUSE`）。
- 并发保护：`tryEnterRuntimeBusy()` 是个全局互斥，登录/运行/停止/退出登录都会先抢它，抢不到直接返回 false。

---

## 五、对我们 agent 的映射

现状：`src/runtime/plugins/devuni/devuniCommands.ts` 里只注册了两个工具——`devuni_project_options` 和 `devuni_create_project`。编译、部署、运行一个都没有。

能直接用的：上面这些命令全部是 `vscode.commands.registerCommand` 注册的，agent 侧 `executeCommand` 就能调，不用重写任何协议。

但有三个坑：

1. 全是零参数命令。它们不看 agent 传什么，只认当前打开的 `.code-workspace` 和内存里的工程模型。所以 agent 只能驱动"已经打开的那个工程"。
2. 全是有状态的。连接、登录、运行是三段状态，中间任何一步失败后面都做不了。agent 不能把它们当成三个独立的幂等操作来调。
3. 会跟用户抢。用户在 IDE 里点编译、agent 同时也调，`tryEnterRuntimeBusy` 会挡掉一个。挡掉的那个会返回 false 而不是报错，agent 得能区分"被挡了"和"做完了"。

最大的缺口不在调用，在格式。我们的 `plc-runtime.json` 是自研 schema，devuni 整个代码库里没有 `plc-runtime` 这个词。它编译要的是 `plc_config.json`，是它自己的设备组态 JSON。我们的 `plcMatiecAdapter` 生成的是 `plc_configuration.st`（IEC 61131-3 的 CONFIGURATION/RESOURCE/TASK/PROGRAM 声明），名字像，用途完全不同。

要打通下游，先解决这一处转换：要么让 devuni 认我们的格式，要么我们按它的 `plc_config.json` 结构生成。其余都是调命令的事。
