# dsh-math-tex — 当前状态（可交接）

包名 `dsh-math-tex` 1.0.0，源码在 `plugin-design/dsh-math-tex/`，
装到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-math-tex\`，
并登记在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的
`dsh.profile.bundles` 与 `dependencies`。

它不是设计文档（设计见 `DESIGN.md`），而是"现在到底装了什么、证明了什么、还差什么"。
原型包 `math-guard` 0.1.0 已退役（已从 bundles 移除，目录留在 `node_modules` 里）。

## 0. 怎么装、怎么测

```powershell
node plugin-design/install.mjs                            # 复制 payload + 登记 bundle（幂等）
node plugin-design/install.mjs --dry-run                  # 只说会改什么
node plugin-design/install.mjs --uninstall dsh-math-tex   # 反安装（可指定别的包名）
cd plugin-design/dsh-math-tex; npm test                   # 8 个测试文件，517 条断言
```

`install.mjs` 只认 `package.json` 的 `files` 列表（`package.json` 本身无条件复制——
少了它 Node 根本解析不了这个目录，而且会在宿主里报 ENOENT 而不是报打包错误）。
所有对 profile `package.json` 的改动都走 `JSON.parse`/`JSON.stringify` 并留 `.bak-*` 备份。

包结构：`lib/index.js`（挂载入口，纯再导出）、`lib/guard.js`（`llm/stream` 守卫 +
提示词段）、`lib/tex-repair.js`（判定与修复）、`lib/config.js`（选项与手写校验）、
`test/`、`locale/`、`dsh-plugin.json`、`README.md` / `README.en.md` / `LICENSE` / `CHANGELOG.md`。

## 1. 它做两件事，互相独立

1. **预防** —— `systemPrompt.section({ name: 'math-output-format', order: 1000 })`
   注入七条中文排版规则（行间公式单独成段、块内不得有标题/正文/粗体、一块一公式、
   标题不得与公式同行、行内公式不超过约 160 字符、结尾用纯文本重述数值、
   最后单独输出哨兵 `⟪MG-REPAIR⟫` 作为"规则已生效"的收据）。
   强度由 `promptRules: 'full' | 'minimal' | 'off'` 控制。
2. **兜底** —— `ctx.on('llm/stream', ...)` 在**文本落库之前**改写流式增量。
   这是唯一能拦住的位置：前端渲染器 patch 不了（KaTeX 内联在 `vendor-CCJJTK99.js`，
   且渲染器不传任何 KaTeX 选项）。

8 个选项见 `lib/config.js`；未知键报错（`additionalProperties: false`），
`enabled: false` 时整个插件不挂任何东西。

## 2. 判据是"渲染结果"，不是"有没有抛异常"

这是整件事最重要的一条，也是走过弯路的结论。产品自己的三段链是：

| 段 | 调用 | 结果 |
| --- | --- | --- |
| 1 | `throwOnError: true` | 成功则正常渲染 |
| 2 | `strict:'ignore'`, `throwOnError:false` | **不抛异常**，把 KaTeX 的报错文字用 `#cc0000` 画出来 |
| 3 | 外层 catch | 红色 span 里塞原始源码 |

**实测推翻了一个我们先前采纳的说法**：第 2 段不是"静默画错、看不出来"，
它同样把错误画成红字（`\foobar` 会显示成红色的 `\foobar`）。

更要紧的是发现了**第三种红**：`\htmlClass{red}{x}` 这类被禁用的扩展命令
**第 1 段是成功的**，输出里仍然有 `#cc0000`。所以
"`judge` 没抛异常 ⇒ 这块没问题"是错的判据。现在改成检查渲染产物里有没有错误色
（`rendersRed(html)`），并把 KaTeX 回显进 `<mtext>` 的那个 token
（`echoedErrorText`）当作修复的抓手。

## 3. 修复策略（只做两种替换，其余降级）

1. 框错了 → 重新框成规范行间块，公式照常渲染；
2. 渲染器不认的命令（`\foobar`、被禁的 `\htmlClass`）→ 去掉反斜杠，
   读者看到 `foobar` 而不是红色 span；`x_1_2` 这类双下标 → 收成 `x_{1_2}`；
3. 以上都不行的结构性损坏（少 `}`）→ 降级成带围栏的源码块。

**不猜**：只做上面两种有确定语义的替换，替换后必须"严格通过且无红色"才接受，
否则整段退回原始文本。这样修复永远不会编造作者没写过的数学。

## 4. 测试（全部离线可复现）

`cd plugin-design/dsh-math-tex; npm test`（或 `node test/run.mjs`），8 个文件按爆炸半径递增：

| 套件 | 结果 | 它到底在问什么 |
| --- | --- | --- |
| `guard-test.mjs` | 39 / 0 | 判据与区域切分跟渲染器一致吗 |
| `red-render-test.mjs` | 48 / 0 | 三类红（抛错、宽松回显、静默错误色）都抓得到吗 |
| `e2e-test.mjs` | 39 / 0 | 真实事故文本走完全程还有红字吗 |
| `wire-test.mjs` | 97 / 0 | 流式输出与整篇一次修复逐字相同吗 |
| `fuzz-test.mjs` | 236 / 0 | 任意切分下都相同吗 |
| `config-test.mjs` | 26 / 0 | 8 个选项真的按文档生效吗 |
| `smoke-test.mjs` | 22 / 0 | 宿主那样加载它，挂得上吗 |
| `installed-test.mjs` | 10 / 0 | profile 里那份副本（而不是源码目录）行为一致吗 |

合计 **517 条断言全绿**。其中 `fuzz-test.mjs` 要求事故文本按 1 字符到 1600 字符
外加随机切分重组为逐字相同的整篇结果；`installed-test.mjs` 会检查
`package.json` 的 `files` 全部落地、`test/` **没有**被复制进 profile、
安装副本与源码 `lib/` 一致（不一致就报"副本过期，重跑 install.mjs"）。

## 5. 还没证明的一件事

**真实回合里钩子被调用、哨兵被移除、落库文本里没有哨兵。**

目前证据：
- `smoke-test.mjs` 用宿主形状的假 context 调 `apply()`：能加载、不抛异常、
  两个注册都到位、假流能穿过并修好 `$$x_1_2$$`。
- `installed-test.mjs` 证明 profile 里那份副本自己就能判定和修复。
- 修复逻辑本身 517 条断言覆盖，不依赖运行时环境。

缺的是运行时那一环：**模型真的输出哨兵 → 守卫真的抠掉 → 落库记录里查不到**。
为此已在 profile 的 `cordis.patch.yml` 里给 `dsh-math-tex` 这一项配上：

```yaml
- id: dsh-math-tex
  name: dsh-math-tex
  config:
    logFile: C:/Users/<user>/Documents/deepseek-harness/default-workspace/plugin-design/math-guard.log
```

验证方法：**重启应用 → 开新会话 → 问一道要推导的题**，然后

```powershell
node plugin-design/plugin/verify-rewrite.mjs          # 解压最新会话记录并搜索哨兵
Get-Content plugin-design/math-guard.log -Tail 20     # 看钩子是否被真实回合调用
```

判据：`math-guard.log` 出现 `guarded stream: N text delta(s) in, M out` 且 **N > 1**
（真实回合会有很多 delta；`N = 1` 是自测留下的），且会话记录里搜不到哨兵。

## 6. 踩过的坑（别重复）

- 按块索引注入（`chunk.index === 0`）是错的：开推理时 index 0 是 reasoning 块。
- 哨兵是**收据**不是终止符：回答在哨兵**之后**继续，旧代码把它当终止符，
  导致哨兵之后的内容一直不放行。
- Node 按 URL 缓存 `import()`：改一个已被进程加载的插件文件**不生效也不报错**，
  换包名或开新会话才可靠。
- `ctx.get('logger')` 拿不到宿主日志（没有任何 runner 日志文件），
  所以守卫需要 `logFile` 才有可查的证据——默认只写 logger，等于没有痕迹。
- 改 profile 的 `package.json` 必须用 JSON 解析器，正则替换曾经把逗号插错块、
  产生非法 JSON（备份 `package.json.bak-*` 是救命用的）。
- 打包时 `files` 列表**必须**包含 `package.json`：它不是一个"作者选择发布的文件"，
  它就是包本身——漏了它 Node 解析不了这个目录，而报错会出现在宿主里（ENOENT），
  不会出现在打包环节。`install.mjs` 现在无条件加上它。
- `install.mjs --uninstall <name>` 必须按参数删除：写死包名的那一版，
  在"反安装 math-guard"时把 dsh-math-tex 从 bundles 里摘了，还报告成功。
- 已退役的探针包：`math-guard-test`、`math-guard-probe2`（目录还在 `node_modules` 里，但已从 bundles 移除）。
