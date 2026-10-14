# Changelog

本文件记录每个版本的**可观察行为**变化。格式参考 Keep a Changelog，版本号遵循语义化版本。

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

[1.1.0]: https://github.com/EnhydraLutristus/dsh-math-tex/releases/tag/v1.1.0
[1.0.0]: https://github.com/EnhydraLutristus/dsh-math-tex/releases/tag/v1.0.0
