# dsh-math-tex — 当前状态（可交接）

包名 `dsh-math-tex` 1.2.0。**仓库根目录就是包根目录**（checkout 在
`default-workspace\dsh-math-tex\`，workspace 里现在只剩这一个项目，其余全在
`default-workspace\_archive\`）。装到
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-math-tex\`，
并登记在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的
`dsh.profile.bundles` 与 `dependencies`。

它不是设计文档（设计见 `docs/DESIGN.md`，实测记录见 `docs/FINDINGS.md`），
而是"现在到底装了什么、证明了什么、还差什么"。
原型包 `math-guard` 0.1.0 已退役（已从 bundles 移除，目录留在 `node_modules` 里，
它的源码在 `default-workspace\_archive\proto\`）。

**包内容与具体题目无关**：`lib/` 的注释、`test/` 的夹具与断言、README 与 CHANGELOG
里的示例一律使用通用推导（级数、定积分、恒等式）。`test/fixtures/real-broken.txt`
复刻的是事故文本的**缺陷形态**（段落中间的 `$$` 配错对、`##` 粘在行间公式里、
未闭合的 `\begin`、结尾代码围栏），不是任何一次具体事故的题材。

## 0. 怎么装、怎么测

```bash
node tools/install.mjs                            # 复制 payload + 登记 bundle（幂等）
node tools/install.mjs --dry-run                  # 只说会改什么
node tools/install.mjs --uninstall dsh-math-tex   # 反安装（可指定别的包名）
npm test                                          # 10 个测试文件，566 条断言
```

`tools/install.mjs` 里所有路径都由 `import.meta.url` 推出来，checkout 放在哪都能跑；
profile 目录可用 `DSH_PROFILE_DIR` 覆盖。

源码已推到公开仓库 **https://github.com/EnhydraLutristus/dsh-math-tex**（`main`，MIT）。

**在这台机器上跑 git 要用包装脚本** `<workspace>\.tools\git.ps1`（把参数原样传给 git）：

```powershell
# 在仓库目录里直接调用即可；参数原样传给 git，仓库位置由当前目录向上找 .git
cd <本仓库>
& $env:DSH_WORKSPACE\.tools\git.ps1 push
& $env:DSH_WORKSPACE\.tools\git.ps1 -C <本仓库> status
```

(`$env:DSH_WORKSPACE` 是 checkout 的上一层目录，即 `.tools\` 所在的位置；
换成绝对路径同样可以。)

（早期版本把仓库路径写死成 workspace 根，于是 `-C <子仓库> push` 会报失败但推送其实
成功了；现在脚本从当前目录向上找 `.git`，也接受显式 `-C`，找不到仓库会明确以 128 退出。
注意参数要**裸传**：写 `& git.ps1 -Args push` 会被当成 `git -Args push`，git 报
`unknown option: -Args`——看起来像推送失败，其实一条命令都没发出去。）

原因不是墙也不是代理（系统里没有任何代理），而是 **DNS 给 `github.com` 解析出的
`20.205.243.166` 在 443 上稳定超时**：连续三次 21s 超时；而同一 /24 的
`.160`–`.165`、`.167`–`.169`、`140.82.11x.3`、`api.github.com`、`codeload.github.com`、
`ssh.github.com` 全部 0.3s 通。GitHub 所有地址共用同一张证书，所以用
`git -c http.curloptResolve=github.com:443:140.82.112.3` 把主机名指到可用 IP，
TLS 校验照样通过（`curl --resolve` 返回 404 而非 TLS 错误，证明这条路是通的）。
`.tools\git.ps1` 就是这件事加三次重试。

凭据放在 `.tools\gh-token.txt`（`gho_` 前缀，scope 仅 `repo`，`.tools/` 已在
`.gitignore` 里），用仓库级 credential helper 交给 git，不写进 remote URL、
不落到 `.git/config` 的明文里。`.tools\gh-device-login.py` 是设备码授权脚本
（自己实现、对每个请求重试，因为 gh 自己不重试）。

`tools/install.mjs` 只认 `package.json` 的 `files` 列表（`package.json` 本身无条件复制——
少了它 Node 根本解析不了这个目录，而且会在宿主里报 ENOENT 而不是报打包错误）。
所有对 profile `package.json` 的改动都走 `JSON.parse`/`JSON.stringify` 并留 `.bak-*` 备份。

包结构：`lib/index.js`（挂载入口，纯再导出）、`lib/guard.js`（`llm/stream` 守卫 +
提示词段）、`lib/tex-repair.js`（判定与修复）、`lib/config.js`（选项与手写校验）、
`test/`、`tools/`、`locale/`、`docs/`、`dsh-plugin.json`、`README.md` /
`README.en.md` / `LICENSE` / `CHANGELOG.md`。

## 1. 它做两件事，互相独立

1. **预防** —— `systemPrompt.section({ name: 'math-output-format', order: 1000 })`
   注入七条中文排版规则（行间公式单独成段、块内不得有标题/正文/粗体、一块一公式、
   标题不得与公式同行、行内公式不超过约 160 字符、结尾用纯文本重述数值、
   最后单独输出哨兵 `⟪MG-REPAIR⟫` 作为"规则已生效"的收据）。

   > 七条规则里最后一条曾误写为「用 `$...$` 输出结论」——那正是事故的第二个触发源
   > （`$` 在中文正文里当货币符号会配错对）。现在改成"用纯文本重述结论数值"。
   > 规则文本本身当然要提 `$$`（不然没法告诉模型怎么用），`test/smoke-test.mjs:133`
   > 就是断言它提到；真正被断言掉的是**要求把公式包在 `$...$` 里**这种写法——
   > `test/config-test.mjs:228` 与 `test/smoke-test.mjs:171` 都要求修完的文本里
   > 不再出现 `$$x_1_2$$` 这类配错对的定界符。

2. **兜底** —— `llm/stream` waterfall：抄完 delta、模型答完的那一刻，把整段回答
   （`text`）交给 `lib/tex-repair.js` 判定与修复，只 emit 修好的部分。
   哨兵被剥离，不进落盘文本。

## 2. 判据是"渲染结果"，不是"有没有抛异常"

用**与客户端同一个** KaTeX 0.16.47（`test/katex.mjs` 从宿主 asar 里抽出 UMD bundle，
按 hash 校验）当 oracle，调用方式与客户端逐字对齐：先
`renderToString(v,{displayMode,throwOnError:true})`，抛异常再
`renderToString(v,{displayMode,strict:'ignore',throwOnError:false})`。

- 只看"抛不抛异常"会漏：`\htmlClass{red}{x}` 严格调用**成功**，但输出里带 `#cc0000`；
  客户端宽松段同样把这类东西画成红色——宽松段不是"静默画对"。
- 所以判据是 **"严格通过且输出无 `#cc0000`"**；实测踩过的坑、各档阈值见
  `docs/FINDINGS.md` 与 `docs/KATEX-MEASUREMENTS.md`。

## 3. 修复策略（只做两种替换，其余降级）

1. **定点施救**——只在两种有确定语义的情况下动：删掉渲染器不认识的命令的反斜杠
   （`\foobar` → `foobar`），或给重复的算子重新分组（`x_1_2` → `x_{1_2}`）。
   改完必须**重新渲染验证"严格通过且无红色"**才接受，所以不会出现"改一下只是把错误
   挪了个位置"的循环；
2. **源码围栏**——修不了的（括号不闭合、`\begin` 没有 `\end`）作为一个代码块原样给出。

**数学永远不会被删掉。** 最坏情况是读者看到公式源码（可复制、可恢复），而不是红字。
猜结构性损坏等于替作者编造数学，这件事不做。

## 4. 测试（全部离线可复现）

| 文件 | 断言 | 挡什么 |
| --- | --- | --- |
| `test/guard-test.mjs` | 39 | 判定与区域切分必须和渲染器一致 |
| `test/red-render-test.mjs` | 48 | 三类红（异常 / 无异常但带红 / 围栏内）都要被发现 |
| `test/e2e-test.mjs` | 39 | 对**原始 KaTeX**逐个区域核对判定：修好的真不红，没修的仍然红 |
| `test/regression-test.mjs` | 23 | 已经发生过的缺陷不许复发（用例逐字引自真实会话记录） |
| `test/wire-test.mjs` | 97 | 真实 DSH 会话里的线上形状；流式输出等于"整段一次修复" |
| `test/fuzz-test.mjs` | 236 | 随机切分 + 随机损坏，不变量：任何切法都不留下红区 |
| `test/config-test.mjs` | 29 | 选项解析与手写校验；**以及 loader 真正读的那个 `Config` 导出** |
| `test/smoke-test.mjs` | 22 | 挂载、再导出、日志、提示词段已注册 |
| `test/installed-test.mjs` | 11 | 装到 profile 的那份与源码一致、且真能用 |
| `tools/live-path-test.mjs` | 22 | **验收**：装好的副本 + profile 的真实配置 + 宿主的挂载路径，坏答案真的变成干净文本 |
| `test/katex.mjs` | — | oracle 自检：bundle 存在、hash 对、版本对 |

合计 **10 个文件、566 条断言**，`npm test` 约 4 秒，全程不需要网络。

## 5. 真实会话里的两次事故（都已被回归测试钉住）

**2026-10-14，用户报告"一维波动方程那个窗口最新的回答又出现红字"。** 查记录（用
`tools/find-red-session.mjs` 与 `tools/inspect-session.mjs`）查出两条：

1. **真正的原因：那个会话根本没加载插件。** profile 的日志文件从来没被创建过——
   而日志是在 `apply` 时写的。这个会话（以及当时所有会话）都早于插件的注册，bundle
   栈是每个会话的 runner 进程启动时读的。所以记录里就是原始文本，屏幕上是原始红字：
   这不是插件坏了，是插件没跑。现在日志**在挂载时就把文件建出来**，于是"文件不存在"
   只可能意味着"没加载"，不再和"加载了但没有输出"混在一起。
2. **顺手查出一个真 bug：结构规则被当成了判据。** `$$d\alpha=0\qquad(\text{$\alpha$ 是闭
   1-形式})$$` 里 `\text{…}` 内部的 `$` 让配对启发式把区域切错，于是它被判为
   `delimiter-inside` 并"修好"——可 KaTeX 本来就能渲染它，而重新排版把文本切开后，围绕
   第二个 `$` 又冒出一个新区间。**判定说修好了，输出反而更糟。** 现在结构规则只是症状，
   最后一句话由渲染器说：`inspect()` 只在"重新排版后渲染器仍然拒绝"时才判 `repair`。

第 2 条的逻辑错误是"把 verdict 当成了 outcome"——**flagged、repaired、fixed 是三件
不同的事**。`test/regression-test.mjs` 因此不复述判定，而是直接渲染**输出来的文本**：
把本节两条真实文本跑一遍，要求没有任何区域会渲染成红色（并且真缺陷仍然被抓住、
仍然被修干净）。把修复回退掉，这个文件会红 4 条。

## 6. 曾经"明明装好了却不工作"的那个原因（已修，1.2.0）

插件在插件列表里显示**异常（failed）**，日志文件永远不出现——`apply` 一次都没被调用过。
不是环境问题，是这个包自己的 `Config` 导出违反了 cordis 的约定：

cordis 解析一个 entry 的配置走 `resolveConfig(runtime, config)`，里面是
`runtime.Config['~standard'].validate(config)`（cordis `lib/index.js:956-962`）。我们的
`Config` 原来是一个**普通 JSON Schema 对象**，没有 `~standard`，于是那一行抛
`TypeError: Cannot read properties of undefined (reading 'validate')`。异常发生在 fiber 的
`_reload()` 里，被它捕获、存进 `_error`、把 fiber 标成 FAILED——**插件在 `apply` 之前就死了**。
所以：

- `apply` 里写日志那段代码根本没跑到，"日志文件不存在"是必然的；
- 插件清单接口只暴露 `fiberPhase`，不带失败原因，所以从界面上永远查不到为什么；
- 反证：把同一个 `Config` 交给同一段解析逻辑，`TypeError` 每次复现（`tools/verify-config-schema.mjs` 现在把这条路钉住了）。

**修法**：`Config` 改成原生 Schemastery schema（`lib/config.js` 的 `loadSchemastery()` +
`buildConfig()`），从 `DEFAULTS` 和同一份描述生成，所以两套声明不会各自漂移。Schemastery
按安装目录解析（`<profile>/node_modules`，宿主本来就放在那里），**取不到时不导出 `Config`**——
这时加载器会认为"这个插件没有配置 schema"，profile 里的 `config:` 块照样作为 `apply` 的第二个
参数传进来，插件仍然能跑。宁可少一个配置界面，也不要一个起不来的 fiber。
`package.json` 加了 `@deepseek-ai/schemastery` 的可选 peer（和 `dshmarket` 一致）。

教训只有一句：**"插件代码看起来没问题"和"插件真的在跑"是两件事**——判定它们的是加载器，
所以契约要照着加载器的实现写，而不是照着"看起来合理"写。

## 7. 还没证明的一件事

**还没有在真实会话里亲眼看到它救回一次事故。** 已经证明的比上次多了一层：

- 宿主确实加载了它、并且确实改写了流：`fiberPhase` 由 `failed` 变 `active`，
  `C:\Users\SuansDeTus\.dsh\profiles\desktop\dsh-math-tex.log` 里记着
  `mounting BUILD=… / oracle: katex 0.16.47 / prompt section … registered / listener registered`，
  以及真实回合的 `guarded stream: 11 text delta(s) in, 3 out`——**这条流被合并改写过了**。
- `tools/live-path-test.mjs` 把"装好的副本 + profile 的真实配置 + 宿主的挂载路径 + 真实增量流"
  接起来测过：5 类真实缺陷（双下标、段落中间的 `$$`、粘在公式里的 `##`、未闭合的 `$`、
  未知控制序列）在关掉修复时**都会红**、开着时**都不红**，22 条断言全绿，日志里留下
  `repaired 1 region(s): oracle-rejected / mid-paragraph-display / unterminated`。

仍然没证明的是**"某次真实回答正好命中红线"**：那几次真实回合里 `repaired` 一行都没有，
说明模型按提示词写对了格式、没有触发红线——这是好事，但它不等于"救回来过"。上一条是
离线复现，不是临场证据。

要拿到临场证据，**开一个新会话**（当前会话不会重载插件），让它写一段有缺陷的推导
（`test/fixtures/real-broken.txt` 就是这种形状，也可以直接说"演示一下 `x_1_2` 这种双下标"），
然后看两处——`%USERPROFILE%\.dsh\profiles\desktop\dsh-math-tex.log` 里有没有新的
`repaired N region(s): …` 行，以及屏幕上那段是不是没有红字。事后可以用
`node tools/find-red-session.mjs` 复查：它按渲染器判定扫所有会话，报告还有哪些回答会渲染成红色。

## 8. 踩过的坑（别重复）

- **别用正则改 profile 的 `package.json`**：`$1,` 曾把逗号写到错误的块里，产出非法
  JSON，差点让 profile 起不来，只能从备份恢复。一切走 JSON 解析并留备份。
- **"规则命中"不等于"位置坏了"**：配对启发式会在 `\text{$…$}` 这类合法写法上误判，
  把结构规则当判据就会去"修"一个本来能渲染的公式，越修越糟。最后一句话必须由渲染器说。
- **verdict ≠ outcome**：`flagged` / `repaired` / `fixed` 是三件事。测试要盯**输出来的
  文本能不能渲染**，而不是盯判定函数说了什么——否则判定错了，测试跟着一起错。
- **"文件不存在"和"没说话"要能区分**：日志在挂载时就建文件，否则出了事根本不知道
  插件到底加没加载。
- **`plugins.install` 走 npm registry**，离线机器上装不了本地目录；本地插件只能在
  profile 的 `node_modules/` 里挂载。
- **`Config` 必须是加载器认的那种 schema**：普通 JSON Schema 会让
  `runtime.Config['~standard'].validate()` 抛 TypeError，fiber 当场 FAILED，`apply` 永远
  不会被调用（1.2.0 修的，见第 6 节）。判定契约要读加载器的实现，别照着"看起来合理"写。
- **`fiberPhase` 是唯一能看到的信号，而它不含原因**：插件清单接口只给状态不给错误，
  所以排查时只能靠插件自己落盘。`apply` 现在无条件写
  `dsh-math-tex-trace.txt`，异常写 `dsh-math-tex-apply-error.txt`——这两个文件是"为什么
  没起来"唯一的外部证据。
- **改完插件必须开新会话**：bundle 栈是会话 runner 进程启动时读的，当前会话不会重载。
- **Node 会缓存已解析的模块**：同一个包名改完内容，正在跑的宿主可能仍用旧模块；
  判断"到底跑的是哪份代码"要在新会话里重新验证，别信 PID 没变就以为没重载。
- **事故文本本身可能是"没坏"的**：夹具如果复刻得不够狠，测试会给出"未发现缺陷"的
  假绿，所以先拿夹具自己去渲染一遍，确认它真的会红。
- **别把本机身份写进代码**：会话目录名是"绝对路径里非字母数字全换成 `-`"得来的，这个
  变换**不可逆**（`C:\a\b-c` 和 `C:\a\b\c` 结果一样），所以不能由路径反推 slug，只能
  运行时扫描 `<dsh home>/sessions/`。工具统一走 `tools/sessions.mjs`，不要在别处再写
  第二份定位逻辑。这个仓库是公开的，路径里的用户名会跟着历史一起被存档。
