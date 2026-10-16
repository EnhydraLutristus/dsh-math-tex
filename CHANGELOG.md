# Changelog

本文件记录每个版本的**可观察行为**变化。格式参考 Keep a Changelog，版本号遵循语义化版本。

## [1.2.2] — 2026-10-16

### 变更

- **`promptRules` 默认值由 `full` 改为新的 `auto`：只给真正用到数学的会话注入提示词规则。**
  在此之前，不论你开哪个窗口，系统提示词里都躺着七条排版规则和一条「输出 ⟪MG-REPAIR⟫ 收据」
  的要求；一段从不排版的对话，每一步都在为这九行付费，而收据本身是可见的机械痕迹。
  现在规则段的 `text` 是一个函数，按会话决定内容：

  - 该会话此前**已经出现过数学**（请求里任一条消息含 `$`、`\(`、`\[`、`\begin{` 或
    `\`-命令）→ 注入 `full` 那七条规则；
  - 否则 → 注入空串，既不要求公式，也不要求收据。

  判定是**粘滞的**：一个会话一旦被标记为数学会话，之后的每一步都拿到同一段文本。这既是为了
  稳定（会话的系统提示词是每一步请求的缓存前缀，规则若时有时无，每翻一次就是一次缓存未命中），
  也是为了不丢防线（`test/guard-test.mjs` F 节直接断言同一会话前后两次 assembly 拿到完全相同的
  字符串）。标记发生在 `llm/stream` 钩子里、请求组装**之后**，所以携带数学的那一次请求本身还
  拿不到规则，从下一次模型步骤开始生效——这是刻意的：在回合中途改变缓存前缀，代价比晚一步高。

  `full` / `minimal` / `off` 语义不变，`full` 仍然给**每个**会话注入那七条。流修复不受任何影响：
  无论 `promptRules` 取什么值，检查器都在每次请求上跑。

- **无法识别会话时不再猜。** section 的 `text` 函数拿到的 `AssembleContext` 里没有会话身份，
  插件是从宿主贯穿整个回合的 initiator 上读的（DSH 里 Agent 的 id 就是会话 id）。若某次组装
  没有 initiator，section 注入空串并在日志里留一行
  `prompt section: no initiator on this assembly; only already-marked sessions get the rules`——
  这种情况下「提示词那一半不再生效」与「这不是数学会话」表现完全一样，不记一笔就查不出来。

- **开发中发现的真问题：`auto` 曾被查表查成 `undefined`。** 第一版把 `auto` 当成第三种规则文案
  去 `PROMPT_RULES['auto']` 取，取不到就直接走「prompt rules disabled by config」分支——
  section 根本不注册。`test/smoke-test.mjs` 的「prompt rules registered」用例当场变红抓住它。
  `auto` 现在只决定**给谁**，文案固定取 `full`。

### 测试

- 断言总数 566 → **594**（10 个文件）：`guard-test` 46 → 60（新增 F 节：六种挂载形态、
  粘滞性、跨会话隔离、无 initiator 的降级），`config-test` 29 → 32（`auto` 的标记链路），
  `smoke-test` 22 → 23，`live-path-test` 22 → 28（装好的副本按宿主方式验证同一个行为）。
- 装好之后**必须重启宿主进程**才生效，开新窗口不够：插件是进程级加载的，新会话沿用进程里那份，
  而 `tools/install.mjs` 打印的「NEW SESSION required」只说对了一半。判断当前跑的是哪一版，
  看日志格式而不是看 `package.json`——`repaired N region(s) so far:` 是 1.2.1 之后的写法。
  实测：1.2.2 装好两小时后，一个真实回合仍在 3 秒内写了 373 行旧格式日志（那次跑的是 1.2.0）。

## [1.2.1] — 2026-10-16

### 修复

- **同一处缺陷在日志里被重复报告几十次。** `createBlockState` 的 `repairWhole()` 每次有内容
  释放都把 `rawFolded + pending` 从头重新修一遍（这是刻意的，修复不满足结合律），但每遍都
  无条件写一行日志。模型在一段坏公式之后继续写正文时，每释放一段就再报一次同一处缺陷——
  真实会话里留下了 61 条一模一样的 `repaired 1 region(s): blank-line-inside`，集中在 2 秒内。
  现在每个文本块记住已经报告过多少处修复，只报告新增的那些：

  ```
  旧：repaired 1 region(s): blank-line-inside        （每个 delta 一行，共 61 行）
  新：repaired 1 region(s) so far: blank-line-inside （一行）
  ```

  `so far` 之后的理由是**本次新增**的，总数仍是累计的，所以之前能读出的信息一条不少。
  修复行为本身没有变化，只有日志变了。`test/guard-test.mjs` 新增 E 节守住这条：116 个 delta
  的流只写 1 行；同一段文本里先后出现两处缺陷时，写出 2 行、每行报一处新的。

## [1.2.0] — 2026-10-15

### 修复

- **插件此前从未真正运行过：`Config` 导出不合加载器的约定。** 表现是插件列表里显示
  **异常（failed）**、日志文件永远不出现，而 `apply` 一次都没被调用。原因不在插件逻辑里：
  cordis 解析 entry 配置走 `resolveConfig(runtime, config)`，实现是
  `runtime.Config['~standard'].validate(config)`（cordis `lib/index.js:956-962`）。原来的
  `Config` 是普通 JSON Schema 对象，没有 `~standard`，那一行抛
  `TypeError: Cannot read properties of undefined (reading 'validate')`；异常在 fiber 的
  `_reload()` 里被捕获、存进 `_error`，fiber 直接变成 FAILED——**在 `apply` 之前就死了**。
  现在 `Config` 是由 `@deepseek-ai/schemastery` 构建的原生 schema，选项与描述都从同一份
  `DEFAULTS` 生成，两套声明不会各自漂移。**行为上唯一的区别是插件真的会加载。**
- **取不到 Schemastery 时不导出 `Config`**，而不是退回旧的普通对象：加载器会认为这个插件
  没有配置 schema，profile 里的 `config:` 块仍然作为 `apply` 的第二个参数传进来，插件照常
  工作；少一个配置界面，好过一个起不来的 fiber。`package.json` 相应加了
  `@deepseek-ai/schemastery` 的可选 peer 依赖（与 `dshmarket` 的做法一致）。
- **挂载失败留下可查的证据**：`apply` 无条件写 `dsh-math-tex-trace.txt`，异常连同堆栈写
  `dsh-math-tex-apply-error.txt`。插件清单接口只暴露 `fiberPhase`、不带失败原因，宿主也不落
  盘 runner 日志，所以在这之前"插件为什么没起来"在系统里没有任何外部证据。

### 新增

- `test/config-test.mjs` 与 `test/installed-test.mjs` 各增加一组断言，钉住加载器读取的
  `Config` 契约（原生 schema 标记、`~standard.validate()`、默认值与 `DEFAULTS` 一致）。
- `tools/verify-config-schema.mjs`：对着已安装的那份入口，独立验证"加载器能解析这个插件的
  配置"，把这次事故的成因变成一条可重跑的命令。
- `tools/diagnose-mount.mjs`：把已安装入口挂到记录型假 ctx 上，打印 ctx 访问顺序和异常。
- `tools/live-path-test.mjs`（已进套件，第 10 个文件）：**验收测试**。原有测试各自证明零件
  是对的，没有一个证明"装好的那份、按 profile 的配置、走宿主挂载的那条路、喂真实增量流，
  出来的文本在渲染器眼里是干净的"——插件恰恰就是在这段里空转了一辈子。每个用例跑两遍：
  `repair: 'off'` 时缺陷必须原样到达读者（否则这个用例根本没坏，第二遍就没有意义），用
  线上配置时同一个缺陷必须消失；同时校验结论与正文都还在、哨兵被去掉、日志里确实有
  `repaired …` 那一行。实测三个原因各命中一处缺陷：`oracle-rejected`、
  `mid-paragraph-display`、`unterminated`。

### 变更

- 断言总数 540 → **566**，10 个文件（`config-test` 26→29，`installed-test` 10→11，
  新增 `live-path-test` 22）。

## [1.1.0] — 2026-10-14

### 变更

- **仓库根目录就是包根目录**：不再有 `plugin-design/` 这一层（仓库里曾经混放侦察脚本、
  数学核对记录和别的题目材料）。`README.md` 随之重写，只讲这个插件。
- **checkout 提到了 workspace 顶层**：本包从 `default-workspace/plugin-design/dsh-math-tex/`
  移到 `default-workspace/dsh-math-tex/`，装完之后 workspace 里只剩它一个项目。仓库自身
  的 git 历史、远端与已安装的 profile 副本都不受影响（profile 指向的是
  `node_modules/` 里那份拷贝，不是这个 checkout）。
- **安装脚本移到 `tools/install.mjs`**：路径全部由 `import.meta.url` 推出，checkout 放在
  哪里都能跑，可用 `DSH_PROFILE_DIR` 指向别的 profile；README 里的命令同步更新。
- **新增 `docs/`**：把判据的来源随包发布——`FINDINGS.md`（到底坏在哪）、
  `KATEX-MEASUREMENTS.md`（逐个用例的实测数字）、`DESIGN.md`（方案怎么定的、否掉了什么），
  外加说明三者分工的 `docs/README.md`。
- **新增 `STATUS.md`** 并纳入发布文件：现在装了什么、证明了什么、还差什么，以及踩过的坑。
- `package.json#files` 增加 `docs` 与 `STATUS.md`。

### 修复

- **结构规则不再单独构成判据。** `$$d\alpha=0\qquad(\text{$\alpha$ 是闭 1-形式})$$` 里
  `\text{…}` 内部的 `$` 让配对启发式把区间切错，于是这个**渲染器完全接受的**公式被判为
  `delimiter-inside` 并"修复"：重新排版把文本切开，围绕第二个 `$` 又冒出一个新区间——
  判定说修好了，输出反而更糟。现在 `inspect()` 只在这类规则命中**且**重新排版后渲染器
  仍然拒绝时才判 `repair`，与 `releaseRegion()` 自身的检查一致。
- **日志在挂载时创建文件**：此前 `logFile` 只在第一次写日志时才出现，于是"插件没加载"
  和"插件加载了但没说话"在磁盘上完全一样——查真实事故时正是被这一点绕住。现在挂载即
  建文件，并额外写一行 `mounting BUILD=… logFile=…`。
- README 与 `test/installed-test.mjs` 里"从包根目录运行 `node install.mjs`"的指引在仓库
  重整后已失效——脚本不在包根目录，且用 `node install.mjs` 从别处运行会找不到入口。
- 文档里的断言计数更正：此前手写的"8 个文件 517 条"与逐文件数字既对不上、也没算上
  `installed-test`。现在的口径是每次 `npm test` 的逐文件输出（本版依次
  39/48/39/23/97/236/26/22/10，合计 **9 个文件 540 条**），文档不再手写总数。

- **工具与文档不再写死本机身份**：`tools/verify-live.mjs` 与 `tools/dump-real-region.mjs`
  原来把 workspace 的会话目录名（由绝对路径转写而来，含用户名）写成常量，因此只能在这一台
  机器的这一个目录里跑。现在新增 `tools/sessions.mjs` 在运行时定位会话记录：按
  `DSH_HOME` → `%USERPROFILE%\.dsh` 的次序推目录（与 `lib/guard.js` 同一套优先级），
  遍历 `<dsh home>/sessions/**` 找出全部会话并按 mtime 排序，因此"最近一次会话"和
  "按 id 找会话"都跨 workspace 可用，工具也不再依赖 checkout 放在哪。
  `verify-live.mjs` 的日志文件同样改为按候选路径实测存在性（显式 `DSH_MATH_TEX_LOG`
  → profile 下的 `dsh-math-tex.log` / `math-guard.log` → workspace 根的旧位置）。
  文档里的 `C:\Users\<用户名>\…` 一律换成 `%USERPROFILE%` / `$env:USERPROFILE`。
  **对插件运行时无影响**：`lib/` 一行未动。

### 新增

- `test/regression-test.mjs`（23 条断言）：用例逐字引自真实会话记录，断言的不是"判定说了
  什么"，而是"**输出来的文本**在渲染器眼里有没有红色"。把本版修复回退掉，这个文件会红
  4 条。
- `tools/find-red-session.mjs`——按渲染器判定扫本机所有会话，列出还有哪些回答会渲染成红色；
  `tools/inspect-session.mjs`——单个会话逐条消息的区域、判定与"守卫会怎么修"；
  `tools/probe-region.mjs`——聚焦一个区间，把候选写法逐个送进渲染器，看到底哪种被接受。

## [1.0.0] — 2026-02-14

首个完整版本，由原型 `math-guard` 0.1.0 重写并打包而来。

### 新增

- **两道防线**，一次挂载：
  - `systemPrompt.section`（id `math-output-format`，order 1000）注入排版规则，三档可选（`full` / `minimal` / `off`）；
  - `llm/stream` waterfall 守卫，用客户端同版本 KaTeX 判定并修复会被渲染成红色的区域，发生在文本落盘之前，因此屏幕、会话记录与上下文压缩同时受益。
- **以渲染产物为判据**，而不是"有没有抛异常"。实测 `\htmlClass{red}{x}` 在严格调用下成功、输出却带错误色 `#cc0000`；只看异常的实现在这里会误判为健康。现在三类红字（抛错、宽松模式回显、静默错误色）都能抓到。
- **定点施救**只允许两种有确定语义的改动（去掉渲染器不认识的命令的反斜杠、给重复算子重新分组），且必须重新渲染验证"严格通过且无红色"才接受，因此不会在"错误被挪了个位置"上打转。
- **修不了就围栏**：结构性损坏以源码块给出，数学永不删除。
- **完整配置面**：`enabled`、`promptRules`、`repair`（`auto` / `check-only` / `off`）、`tailBuffer`、`maxHold`、`logFile`、`katexPath`、`macros`。未知键报错而非静默忽略。
- **测试套件 8 个文件 517 条断言**（`npm test`），其中 `fuzz-test` 要求真实事故文本的任意切分（1 字符一帧到 1600 字符一帧，外加随机切分）重组为逐字相同的整篇修复结果，`installed-test` 校验宿主 profile 里那份副本（而不是源码目录）能加载、导出面完整、并且自己就能修复。
- **夹具与包内容与具体题目无关**：`test/fixtures/real-broken.txt` 保留事故文本的**缺陷形态**（同一批缺陷类别、同样的区域数量与配对错位），内容替换为通用推导；示例、文档与注释中不再出现任何一次具体事故的题材。
- **`tools/inspect-fixture.mjs`**：对任意文本打印区域数量、被标记的区域与原因、修复动作，以及修复后是否仍有区域会渲染成红色——用来独立复核判定，不必先读源码。
- 包结构：`lib/`（`index.js` / `guard.js` / `tex-repair.js` / `config.js`）、`test/`、`locale/`、`dsh-plugin.json` 清单、图标及其生成脚本。

### 变更（相对原型 `math-guard` 0.1.0）

- **包名与入口**：`math-guard`（单文件 `index.js`）→ `dsh-math-tex`（`lib/` 四个模块）。旧的单文件副本与 `math-guard-test`、`math-guard-probe2` 探针包已退役。
- **KaTeX 解析**：由硬编码绝对路径改为按 `katexPath` → 宿主 profile → 裸 specifier 的顺序解析，任一来源不可用时插件仍然挂载、只是不修复（绝不因找不到渲染器而让回合失败）。
- **日志路径**：由硬编码工作区路径改为 `logFile` 配置项，默认只写宿主 logger。
- **流式等待有界**：扣留文本受 `tailBuffer` 与 `maxHold` 双重约束，超限即按无插件行为原样放行。

### 修复（原型阶段发现、本版包含）

- 完成记号被当作"回答到此结束"，导致记号之后的正文被截断——现在记号是**回执**，回答在它之后继续。
- 释放点可能落在 `$$` 中间，使守卫与修复器对同一区域的理解不一致——现在释放点会回退到定界符串之外。
- 逐片修复而非整体修复，导致前缀性质失效（曾出现 19 字句子只发出 4 字、其余永久滞留）——现在每次结算都修复"已折叠原文 + 待处理文本"这一整体。

### 已知边界

- 渲染器不可修改：前端是 `app.asar` 内的整体 bundle，没有与数学相关的 slot 可替换。这是本插件的设计前提。
- 仅 host 侧：唯一能同时影响屏幕、记录与压缩的拦截点是 `llm/stream`。
- 打开但未闭合的 `$$` 会吞掉后续正文，这属于 Markdown 解析行为，不属于可修复的公式区域。

  [1.2.2]: https://github.com/EnhydraLutristus/dsh-math-tex/releases/tag/v1.2.2
  [1.2.1]: https://github.com/EnhydraLutristus/dsh-math-tex/releases/tag/v1.2.1
  [1.2.0]: https://github.com/EnhydraLutristus/dsh-math-tex/releases/tag/v1.2.0
[1.1.0]: https://github.com/EnhydraLutristus/dsh-math-tex/releases/tag/v1.1.0
[1.0.0]: https://github.com/EnhydraLutristus/dsh-math-tex/releases/tag/v1.0.0
