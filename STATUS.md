# dsh-math-tex — 当前状态（可交接）

包名 `dsh-math-tex` 1.2.7。**仓库根目录就是包根目录**（checkout 在
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
npm test                                          # 10 个测试文件，646 条断言
```

`tools/install.mjs` 里所有路径都由 `import.meta.url` 推出来，checkout 放在哪都能跑；
profile 目录可用 `DSH_PROFILE_DIR` 覆盖。

源码已推到公开仓库 **https://github.com/EnhydraLutristus/dsh-math-tex**（`main`，MIT）。

> **推送工具链现状（2026-10-17：已修好，裸 `git push` 就行）**：现在用官方 GitHub CLI 当
> git 的 credential helper，**不需要** `<workspace>\.tools\` 里的任何东西——那个目录已不在
> 磁盘上（`git.ps1`、`gh-token.txt`、`bin\gh.exe` 都没了），仓库级那条指向
> `.tools\bin\gh.exe` 的 `credential.helper` 也已从 `.git/config` 删掉。留着下面这段是因为
> 它记下了这次装配踩到的两个坑。
>
> 装配过程（在这台机器上重做一遍就这些命令）：
>
> ```powershell
> # 1) 装 gh。winget 在这台机器上拉不下来（0x80072efd），直接下 MSI 再"解包安装"：
> #    没有管理员权限时 msiexec /i 会以 1603 失败，改用 /a 只解包、不写 HKLM。
> msiexec /a gh.msi /qb TARGETDIR=C:\Users\<你>\gh-cli
> # 2) 登录（设备码流程：给一个 8 位一次性代码，在浏览器打开 github.com/login/device 输进去）
> & "C:\Users\<你>\gh-cli\Program Files\GitHub CLI\gh.exe" auth login --hostname github.com `
>     --git-protocol https --web --insecure-storage
> # 3) 把 gh 二进制复制到**不含空格**的路径，再让它去写 git 配置：
> Copy-Item "C:\Users\<你>\gh-cli\Program Files\GitHub CLI\gh.exe" "C:\Users\<你>\gh-cli\gh.exe"
> & "C:\Users\<你>\gh-cli\gh.exe" auth setup-git --hostname github.com
> ```
>
> 两个坑，都实测踩过：
> ① `--with-token` 要求 token 至少含 `repo`、`read:org`、`gist` 三个 scope，而本机凭据管理器
> 里那条只有 `gist, repo, workflow`，于是报
> `error validating token: missing required scope 'read:org'`；走设备码流程登录才带上
> `read:org`。另外 `--scopes` 不能和 `--with-token` 一起用。
> ② **git 的 `credential.helper` 值不能含空格**。gh 默认装在 `Program Files` 下，直接写这个
> 路径会让 git 把值截断，报
> `git: 'credential-C:UsersSuansDeTusgh-cliProgram' is not a git command`
> ——gh 自己 `auth setup-git` 写进去的 `!'…\gh.exe' auth git-credential` 形式也一样，因为
> `!` 后面的路径里有空格。把 `gh.exe` 复制到 `C:\Users\<你>\gh-cli\gh.exe` 这种无空格路径即可。
>
> 验证方法（不打印凭据本体）：
> `printf 'protocol=https\nhost=github.com\n\n' | git credential fill` 应返回
> `username=<你的账号>` 和一段 `password=`；`git ls-remote origin refs/heads/main` 能直接打出
> commit id，就说明推拉都通了。
>
> **这台机器的网络会间歇性掐掉 git 的传输**（不是认证问题）：同一分钟内，`http://…/info/refs`
> 的探测能在 1s 内返回 200，也可能 20s 后 `Recv failure: Connection was reset` 或
> `GnuTLS recv error (-110)`。所以脚本/CI 里推要带重试。实测有效的兜底顺序：
> ① 先直接 `git push`；② 失败就试
> `git -c http.curloptResolve=github.com:443:140.82.113.3 -c http.version=HTTP/1.1 push`
> （`140.82.113.3` 是本轮唯一稳定给 200 的 IP，`140.82.112.3` 和 `20.205.243.165` 都超时，
> `20.205.243.168` 回 400）；③ 还不行就从 WSL 里推——WSL 的 git 与本机 Windows git 走的是
> 两条不同的网络栈，Windows 侧被 reset 时 WSL 侧往往一次就过，只是 WSL 里没有 credential
> helper，要在命令行上临时把 token 递进去（不要写进任何 git config）：
>
> ```bash
> TOKEN=$(sed -n 's/^[[:space:]]*oauth_token:[[:space:]]*//p' \
>   "/mnt/c/Users/$USER/AppData/Roaming/GitHub CLI/hosts.yml" | head -1 | tr -d '\r')
> GH_TOKEN="$TOKEN" git -c credential.helper='!f() { printf "username=x-access-token\npassword=%s\n" "$GH_TOKEN"; }; f' \
>   push origin HEAD:main
> ```
>
> 下面这段是历史记录（当时 `.tools\git.ps1` 包装脚本 + `curloptResolve` IP 兜底的方案），
> 现在**不需要了**：`.tools\` 已经不在磁盘上，凭据也不再经它传递。留着是因为它解释了
> "同一台机器上某个 github.com IP 会稳定超时"这个现象。

<!-- 历史：当时需要 bypass DNS 的坏 IP，脚本内容如下 -->
<!--
**在这台机器上跑 git 要用包装脚本** `<workspace>\.tools\git.ps1`（把参数原样传给 git；当前已不存在）：

```powershell
cd <本仓库>
& $env:DSH_WORKSPACE\.tools\git.ps1 push
```

原因不是墙也不是代理（系统里没有任何代理），而是 **DNS 给 `github.com` 解析出的
`20.205.243.166` 在 443 上稳定超时**：连续三次 21s 超时；而同一 /24 的
`.160`–`.165`、`.167`–`.169`、`140.82.11x.3`、`api.github.com`、`codeload.github.com`、
`ssh.github.com` 全部 0.3s 通。GitHub 所有地址共用同一张证书，所以用
`git -c http.curloptResolve=github.com:443:140.82.112.3` 把主机名指到可用 IP，
TLS 校验照样通过。`.tools\git.ps1` 就是这件事加三次重试。

凭据当时放在 `.tools\gh-token.txt`（`gho_` 前缀，scope 仅 `repo`，`.tools/` 在
`.gitignore` 里），`git.ps1` 把它导出成 `GH_TOKEN` 再交给 git。
-->

`tools/install.mjs` 只认 `package.json` 的 `files` 列表（`package.json` 本身无条件复制——
少了它 Node 根本解析不了这个目录，而且会在宿主里报 ENOENT 而不是报打包错误）。
所有对 profile `package.json` 的改动都走 `JSON.parse`/`JSON.stringify` 并留 `.bak-*` 备份。

包结构：`lib/index.js`（挂载入口，纯再导出）、`lib/guard.js`（`llm/stream` 守卫 +
提示词段）、`lib/tex-repair.js`（判定与修复）、`lib/config.js`（选项与手写校验）、
`test/`、`tools/`、`locale/`、`docs/`、`dsh-plugin.json`、`README.md` /
`README.en.md` / `LICENSE` / `CHANGELOG.md`。

## 1. 它做两件事，互相独立

1. **预防** —— `systemPrompt.section({ name: 'math-output-format', order: 1000 })`
   注入八条中文排版规则（行间公式单独成段、块内不得有标题/正文/粗体、一块一公式、
   标题不得与公式同行、行内公式不超过约 160 字符、不用 HTML 标签排版、
   结尾用纯文本重述数值、最后单独输出哨兵 `⟪MG-REPAIR⟫` 作为"规则已生效"的收据）。

   **注入给谁由 `promptRules` 决定，默认 `auto`**：只给对话里已经出现过数学的会话。
   判据是 `llm/stream` 里那次请求的 `options.messages`（含 `$`、`\(`、`\[`、`\begin{`
   或 `\`-命令即算），标记**粘滞**——一个会话一旦被标记，之后的每一步都拿到同一段文本。
   粘滞既为缓存（会话的系统提示词是每一步请求的前缀，文本时有时无就是反复的缓存未命中），
   也为防线不丢（`test/guard-test.mjs` F 节直接断言同一会话两次 assembly 得到完全相同的字符串）。
   标记发生在请求组装之后，所以**携带数学的那一次请求本身还没有规则**，下一步才生效——
   刻意如此：在回合中途改前缀，比晚一步贵。

   `full` 仍然给每个会话注入八条，`minimal`、`off` 语义不变。修不修跟这个选项无关：
   无论 `promptRules` 取什么值，`llm/stream` 的检查都在跑。

   > 八条规则里倒数第二条（不用 HTML 标签）是 1.2.6 加的：模型在被要求"把对比表压成
   > 一行"时直接写了 `<ol><li><b>`，而这里渲染的是 Markdown，标签原样显示成文字。
   > 日志侧的 `RAW_HTML` 检查只报不改——正文是模型的东西，静默改写它比露出标签更糟。

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
   挪了个位置"的循环。判据来自渲染器**两份账本**：HTML 里的 `<mtext>` 回显（渲染器真正
   画出来的），以及错误信息里的回显——后者用 U+0332 标出出错字符，先剥记号再匹配。
   双下标这类错误的回显只在 `message` 里，只看 HTML 会漏（1.2.3 修的就是这个）；
2. **降级**——修不了的（括号不闭合、`\begin` 没有 `\end`）原样给出源码：
   **块级**区域包成代码围栏，**行内**区域只去掉定界符。围栏是多行结构，用在行内会把
   一条表格行切成三段，剩下的半行还会被当成新的行解析。

**数学永远不会被删掉。** 最坏情况是读者看到公式源码（可复制、可恢复），而不是红字。
猜结构性损坏等于替作者编造数学，这件事不做。

## 4. 测试（全部离线可复现）

| 文件 | 断言 | 挡什么 |
| --- | --- | --- |
| `test/guard-test.mjs` | 83 | 判定与区域切分必须和渲染器一致；一处缺陷只许报告一次；修复不许破坏周围的 Markdown 结构；释放点不许落进未闭合的行内代码（否则整段回答被吞）；裸 HTML 的日志在标签被切分到多次释放时也要报出 |
| `test/red-render-test.mjs` | 68 | 三类红（异常 / 无异常但带红 / 围栏内）都要被发现；回显从 HTML 与 message 两份账本里取，红渲染没有 message 时取画出来的 span |
| `test/e2e-test.mjs` | 39 | 对**原始 KaTeX**逐个区域核对判定：修好的真不红，没修的仍然红 |
| `test/regression-test.mjs` | 23 | 已经发生过的缺陷不许复发（用例逐字引自真实会话记录） |
| `test/wire-test.mjs` | 103 | 真实 DSH 会话里的线上形状；流式输出等于"整段一次修复" |
| `test/fuzz-test.mjs` | 236 | 随机切分 + 随机损坏，不变量：任何切法都不留下红区 |
| `test/config-test.mjs` | 32 | 选项解析与手写校验；**以及 loader 真正读的那个 `Config` 导出** |
| `test/smoke-test.mjs` | 23 | 挂载、再导出、日志、提示词段已注册 |
| `test/installed-test.mjs` | 11 | 装到 profile 的那份与源码一致、且真能用 |
| `tools/live-path-test.mjs` | 28 | **验收**：装好的副本 + profile 的真实配置 + 宿主的挂载路径，坏答案真的变成干净文本 |
| `test/katex.mjs` | — | oracle 自检：bundle 存在、hash 对、版本对 |

合计 **10 个文件、646 条断言**，`npm test` 约 4 秒，全程不需要网络。

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

## 7. 它救回来的第一次真实事故（2026-10-16 20:16，已抓到证据）

用户在窗口里输入「演示一下 `x_1_2` 这种双下标」，插件对**真实回合**动过手，三处证据齐全：

1. **钩子确实被调用**：日志 `2026-10-16T12:16:18.082Z llm/stream hooked model=deepseek-flash mode=auto`。
2. **判定确实命中**：同一秒起 `repaired N region(s): oracle-rejected`，三处缺陷（`$$x_1_2 \;=\; x_{1_2}$$`
   与两处行内 `$x_1_2$`，双下标是 KaTeX 报错的形状）。
3. **输出确实不含红**：把记录里的原文按 live 路径（分块 → `guardStream` → 拼接）重放一遍，
   出口文本用真 KaTeX 判定是 **11 个区域、0 个会红**（原文 14 个区域、3 个会红）；哨兵也被剥掉了。

有一点要说清楚：会话记录里存的仍是**修复前**的原文（`$$x_1_2 \;=\; x_{1_2}$$` 还在里面），
这不是没修，而是 `assistant/message` 落盘的是模型原始文本，守卫改的是往外发的流。
所以"记录还是红的"不能用来判断屏幕上是不是红的——判断要看同一次流放的出口，见上。

这次修复的形态是**围栏**：修不好的区域按源码块给出，于是那句行内公式变成了
"渲染出来是" + 一个代码块 + "：`1` 是正常下标…"。能读、不红，但排版不再紧凑。这是
"宁可围栏，不让红字过去"的既定取舍，不是故障。

### 由此暴露的一个真问题：只看日志会把"没重启"误判成"没工作"

那次回合在 **3 秒内写了 373 行** `repaired N region(s): …`（303×3 处、62×2 处、8×1 处），
因为宿主进程从 17:31 起就没重启过，内存里跑的还是 **1.2.0** 的旧代码——1.2.1 的"一处缺陷只报一次"
和 1.2.2 的 `auto` 都还没生效。装上不等于生效：宿主进程不重启，`apply` 不会再跑一遍。

判断依据是日志格式本身：1.2.1 起写的是 `repaired N region(s) so far: …`。全文 627 行旧格式、
0 行新格式，说明磁盘上的新代码一行都没执行。

面板上那两个现象（行内公式被撑成代码块、哨兵留在记录里）也都是 1.2.0 的行为，
与上面这次修复是同一次事故的两面，不是两个故障。

## 7c. 它的第一次真实数据丢失（2026-10-16，1.2.5 修复）

用户做了 A/B 对照：同一个问题在两个窗口里各问一次，一个**不挂插件**，一个**挂插件**。
不挂的那个把 `$x_1_2$` 原文交给渲染器，读者看到红色 `x_1_2`；挂插件的那个第一轮把公式改写成了
`$x_{1_2}$`（正确），但**第三轮的回答短得不正常**。

把那一轮回放一遍（记录里的原文按 7 字一块喂 `guardStream`）就露出来了：

- 原文 **2213 字**，出站只有 **822 字**；日志里 **199 行**
  `repair would rewrite emitted text; holding N chars for the next release`。
- 原因是**释放点落进了一个未闭合的行内代码跨度**：原文里写着
  `` 所以我这行 `$x_1_2$` 在出站时会被 … ``，某一刻待发文本恰好停在收尾反引号之前。
  那段碎片里，`$x_1_2$` 在反引号**外**，于是被当成一个未闭合的行内区域修掉（`$` 被删）。
  下一个字符（反引号）到达后，它变成代码跨度里的字面文本，不再该被改——修出来的结果
  和已经发出去的文本对不上，`settle` 按"修复必须延长已发出的文本"的规则**拒绝释放**。
  而这个拒绝是**不可自愈**的：之后每一次释放都会再次对不上，于是整段回答的剩余部分被永久扣住，
  直到块结束才由 `finish()` 一次性倒出来（在 GUI 上表现为回答戛然而止）。
- 直接量到的分叉点：`repairText(前 817 字)` 与 `repairText(前 818 字)` 在第 813 字处开始不同
  ——**修复不是前缀单调的**，而流式输出的正确性完全依赖它。

**修法**：`safeCut`（`lib/guard.js`）除了"未闭合的数学区域"之外，也把"未闭合的行内代码跨度"
算作不可切点（`unclosedRunStart`）。文本停在收尾反引号之前时不再释放，等它闭合，
`$` 的含义就不会在两次释放之间改变。

判断是**无条件的**，"跨度里已经出现 `$` 才等"是错的一半：开场反引号到达的那一刻跨度还是空的，
按"有没有 `$`"判断恰好会放行最危险的那一次释放（810 → 811 的实测就是如此）。围栏代码（行首
三个以上）例外，它在切点两侧都是字面文本。

`maxHold` 到期时的退路分两侧：**未闭合的数学区域**按原文不修放行（`$$` 一直不闭合也不能把
后面的正文扣住），**未闭合的行内代码**没有这条退路——它一旦被切错就再也对不上，只能等闭合。

**验收**：那次真实回答现在出站 **2204/2213** 字（差额是公式改写本身：`$x_1_2$` → `$x_{1_2}$`
多出的花括号），199 行 holding 归零；四轮全部 0 行 holding、0 处红色残留。
`test/guard-test.mjs` 新增 E2 节、`test/wire-test.mjs` 新增 D2 节把它钉住（共 10 条断言）。

## 7d. 1.2.6 的检测器一次都没响过（2026-10-16，1.2.7 修复）

1.2.6 上线后让用户跑一轮验收（`test/fixtures/live-check-prompt.md`）。那一轮**回答干净**，
但顺手把所有带标签的真实回答重放一遍验证检测器时，发现它**一次都没报**——
包括 1.2.6 交付时用来证明"能报"的那两条。

原因是检测的**输入取错了**：1.2.6 拿"这次新释放的那一片"去匹配 `RAW_HTML`，
而一片可以只装半个标签。实测 `session-134bbd9f` 的回答是按 7 字符增量到达的：

```
piece [594,601) = "rn <spa"
piece [601,608) = "n class"
piece [608,615) = "Name=\"k"      …
```

`<span …>` 被切在多次释放之间，没有任何一片同时含开头与闭口的 `>`，于是**一行日志都没有**。
1.2.6 交付时用全量一次性喂入做验证，恰好绕开了这个形状；改成按 7 字符喂入立刻复现
（`released pieces=217, pieces containing a tag=0`，而输出与原文逐字节相同——文字没坏，坏的是检测）。
第二个形状是标签压在最后几个字符里（`session-e902866d`），它们从 `finish` 出去，
只查 `push` 的写法同样看不见。

**修法**：`reportHtmlOnce` 拿到的是**累积到此刻的整段修复文本**（`settle` 里传 `repaired`，
而 `settle` 是包括 `finish` 在内的唯一释放闸门）。累积文本对两种形状都免疫，也不会误报：
`RAW_HTML` 要求闭口的 `>`，半截 `<spa` 只是等下一次释放。

**验收**：`tools/replay-html-check.mjs --all` 把全机 **10 条**带标签的真实回答重放一遍，
10/10 各报一行、0 行 holding、输出与原文逐字节相同（`0 without the expected report`）。
`test/guard-test.mjs` 补两条断言（按 7 字符 / 9 字符喂入，标签被拆开仍要报一次、
标签落在尾部由 `finish` 报出），两条都要求答案逐字节不变。

**教训**：验证一个"只能在流式路径上工作"的检查，必须用**真实的分块形状**喂它。
一次性喂全量会把流式缺陷全部藏起来——1.2.5 的释放缺陷也是靠 7 字一块喂才露出来的（见 7c）。

## 7b. 仍然没证明的

- `auto`（1.2.2）在真实会话里到底有没有按预期注入——需要一次「重启宿主 + 一个数学窗口
  + 一个非数学窗口」的对照，日志里看 `prompt rules now apply to session …` 出现与否。
- 修复的**质量**：三处缺陷里两处被围栏，只有一处（`x_1_2` 的源码块）是读者真正想要的形态；
  "围栏率"没有度量，也没有目标。
- 会话记录里的哨兵：`tools/strip-sentinel.mjs` 能清（已清掉 `session-8c6a99cc` 的 10 处、
  `session-ea68db00` 的 5 处、`session-b062cda8` 的 2 处），但**当前正在写的会话不能动**，
  而且重启后新会话不会再产生它。

复查工具：`node tools/find-red-session.mjs [--all]` 按渲染器判定扫所有会话，报告还有哪些回答会渲染成红色；
`node tools/strip-sentinel.mjs --list` 报告哪些记录的正文里还留着哨兵（`--id <前缀> --yes` 清掉）。

## 8. 踩过的坑（别重复）

- **装上不等于生效，开新窗口也不等于重启**：宿主的插件是进程级加载，新会话沿用进程里那份。
  1.2.1 在 18:12 装好、1.2.2 在 18:34 装好，而进程 17:31 就起来了——20:16 的回合跑的还是 1.2.0，
  3 秒 373 行日志就是证据。**判断当前跑的是哪版，看日志格式，不要看 `package.json`**：
  `repaired N region(s) so far:` 是 1.2.1 之后的写法，旧格式 `repaired N region(s):` 说明还没重启。
- **读会话记录前先确认解码器能读多帧**：记录是 zstd 帧的拼接（每次追加一帧），
  `zstdDecompressSync` 只解第一帧。`tools/find-red-session.mjs` 曾因此对每个新记录都报
  "0 assistant messages"，而"什么都没找到"看起来和"一切正常"一模一样。现在统一走
  `tools/zstd-frames.mjs`。
- **`auto` 不是一个规则集，是一个受众决定**：第一版把它当成第三种文案去
  `PROMPT_RULES['auto']` 查表，查不到就落进"配置关掉了提示词"的分支，section 根本不注册——
  `test/smoke-test.mjs` 的"prompt section registered"用例当场变红。文案永远取 `full`，
  `auto` 只决定给谁。
- **判据要读**请求**里的消息，不是模型刚写的那段文本**：`llm/stream` 的
  `options.messages` 是这一次请求的全部上下文（含用户刚发的那句），而 `options.system`
  是本步已经组装好的提示词——后者反映的是上一步的决定，拿它当"要不要注入"的输入会形成
  自锁：因为没注入所以看不到数学，因为看不到数学所以永远不注入。
- **`createBlockState` 的日志参数叫 `log`，`guardStream` 的叫 `onLog`**：名字写错不报错，
  静默退回模块级空函数，"检查日志"的测试于是检查零行并假绿（1.2.1 的 E 节踩过）。
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
- **"块内一处缺陷、条条日志都报它"是流式重修的必然结果，不是重复发现**：`settle` 每次
  释放都把 `rawFolded + pending` 从头再修一遍（修复不满足结合律，只能整段重来），所以
  日志必须按"已报告过几处"去重，否则模型在坏公式后面每写一段正文就再报一次同一处缺陷
  ——真实会话里出现过 61 行完全相同的 `blank-line-inside`（1.2.1 修的，`announced` 计数）。
  注意去重的是**日志**，不是修复本身：每遍仍然要真修。
- **`createBlockState` 的日志回调叫 `opts.log`，`guardStream` 的叫 `opts.onLog`**：写错名字
  不会报错，会静默退回模块默认的空函数，于是测试"检查日志"却在检查零行——本仓库真的这样
  绿过一次（E 节第一版）。测试里传错名字比不传更危险。
- **别把本机身份写进代码**：会话目录名是"绝对路径里非字母数字全换成 `-`"得来的，这个
  变换**不可逆**（`C:\a\b-c` 和 `C:\a\b\c` 结果一样），所以不能由路径反推 slug，只能
  运行时扫描 `<dsh home>/sessions/`。工具统一走 `tools/sessions.mjs`，不要在别处再写
  第二份定位逻辑。这个仓库是公开的，路径里的用户名会跟着历史一起被存档。
- **释放点不能落进未闭合的行内代码**：同一个 `$` 在反引号里和在反引号外含义不同，
  所以"到这里的文本已经定了"这句话在未闭合的代码跨度里不成立。1.2.5 修的就是这个：
  释放点落在 `` `$x_1_2$` `` 的收尾反引号之前，那段碎片被当成未闭合区域修掉（删了 `$`），
  之后每一次释放修出来的结果都和已经发出去的文本对不上，`settle` 于是永久拒绝释放——
  一次真实回答里 2213 字只发出去 822 字，日志里 199 行
  `repair would rewrite emitted text; holding …`。**"拒绝释放"这种防御一旦触发就不会自愈**，
  所以它必须是一个测试钉住的前置条件（`safeCut` 现在把未闭合的代码跨度也算作不可切点），
  而不是一个兜底分支。
- **"未闭合就不释放"这条规则必须无条件成立，不能加"跨度里已经有 `$` 才等"这类前提**：
  开场反引号到达的那一刻，跨度还是空的——按"里面有没有 `$`"判断恰好会放行最危险的那一次
  释放（实测 810 字放行、811 字才该拦，差值就是一个反引号）。测试要盯的是"切点有没有落进
  未闭合结构"，不是"内容看起来危不危险"。
- **同一个 `maxHold` 退路，对区域成立、对行内代码不成立**：区域超时可以按原文不修放行
  （读者的损失是"这段公式没修"，而不放行的损失是"后面整篇正文都发不出去"）；
  行内代码超时放行则是**永久性**的——放出去的那一段已经进了读者的屏幕，之后再修出来的结果
  永远对不上它。所以同一条兜底规则在一侧是必要的，在另一侧是有害的，得分开写。
- **别把测试写成"今天的缺陷说明书"**：`wire-test` 原先有一条断言「超长未闭合区域仍被扣住」
  ——它把当时那个"永久扣住整段回答"的行为写成了期望，于是修 bug 时它反而先红。
  断言要写给**要求**，不要写给**现状**；现状里那些说不清的部分只能作为反例（如
  `x_1_2_3` 降级）单独标注出来。
- **修复函数不是前缀单调的，而流式输出必须是**：`repairText(前 n 字)` 一般不是
  `repairText(前 n+1 字)` 的前缀——释放边界一动，区域的排版跟着变。上述缺陷就是这条的
  一次实测：`n=817` 与 `n=818` 的结果在第 813 字处分叉。所以"流式输出 == 整篇修复"
  这个不变量只能靠**前瞻式释放规则**（绝不切开任何未定的结构）来保证，不能靠事后比对。
