# dsh-math-tex — 当前状态（可交接）

包名 `dsh-math-tex` 1.0.0。**仓库根目录就是包根目录**，
装到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-math-tex\`，
并登记在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的
`dsh.profile.bundles` 与 `dependencies`。

它不是设计文档（设计见 `docs/DESIGN.md`，实测记录见 `docs/FINDINGS.md`），
而是"现在到底装了什么、证明了什么、还差什么"。
原型包 `math-guard` 0.1.0 已退役（已从 bundles 移除，目录留在 `node_modules` 里）。

**包内容与具体题目无关**：`lib/` 的注释、`test/` 的夹具与断言、README 与 CHANGELOG
里的示例一律使用通用推导（级数、定积分、恒等式）。`test/fixtures/real-broken.txt`
复刻的是事故文本的**缺陷形态**（段落中间的 `$$` 配错对、`##` 粘在行间公式里、
未闭合的 `\begin`、结尾代码围栏），不是任何一次具体事故的题材。

## 0. 怎么装、怎么测

```bash
node tools/install.mjs                            # 复制 payload + 登记 bundle（幂等）
node tools/install.mjs --dry-run                  # 只说会改什么
node tools/install.mjs --uninstall dsh-math-tex   # 反安装（可指定别的包名）
npm test                                          # 8 个测试文件，517 条断言
```

`tools/install.mjs` 里所有路径都由 `import.meta.url` 推出来，checkout 放在哪都能跑；
profile 目录可用 `DSH_PROFILE_DIR` 覆盖。

源码已推到私有仓库 **https://github.com/EnhydraLutristus/dsh-math-tex**（`main`）。

**在这台机器上跑 git 要用包装脚本** `<workspace>\.tools\git.ps1`（把参数原样传给 git）：

```powershell
# 假设当前在这个仓库的根目录（`.tools\` 相对 workspace 根，要在 workspace 根调用）
..\..\.tools\git.ps1 -C . status
..\..\.tools\git.ps1 -C . push
```

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
| `test/guard-test.mjs` | 39 | 流式分块的输出必须等于"整段一次修复"的结果；哨兵时刻 |
| `test/wire-test.mjs` | 48 | 真实 DSH 会话里的线上形状 |
| `test/e2e-test.mjs` | 39 | 对**原始 KaTeX**逐个区域核对判定：修好的真不红，没修的仍然红 |
| `test/red-render-test.mjs` | 97 | 三类红（异常 / 无异常但带红 / 围栏内）都要被发现 |
| `test/fuzz-test.mjs` | 236 | 随机切分 + 随机损坏，不变量：任何切法都不留下红区 |
| `test/config-test.mjs` | 26 | 选项解析与手写校验 |
| `test/smoke-test.mjs` | 22 | 挂载、再导出、日志、提示词段已注册 |
| `test/installed-test.mjs` | 10 | 装到 profile 的那份与源码一致、且真能用 |
| `test/katex.mjs` | — | oracle 自检：bundle 存在、hash 对、版本对 |

合计 **8 个文件、517 条断言**，`npm test` 约 4 秒，全程不需要网络。

## 5. 还没证明的一件事

**没有在真实会话里亲眼看到它救回一次事故。** 已证明的是：插件在宿主里真的被加载并
改写流（probe 阶段用哨兵证明过，见 `docs/FINDINGS.md`）、判定用的是同一个渲染器、
517 条断言在离线环境全绿。未证明的是"某次真实回答正好命中红线并被就地修好"。

验证方法：开新会话，让模型输出一段有缺陷的推导（`test/fixtures/real-broken.txt`
就是这种形状），然后看会话记录里的文本是不是已经被改过。

## 6. 踩过的坑（别重复）

- **别用正则改 profile 的 `package.json`**：`$1,` 曾把逗号写到错误的块里，产出非法
  JSON，差点让 profile 起不来，只能从备份恢复。一切走 JSON 解析并留备份。
- **`plugins.install` 走 npm registry**，离线机器上装不了本地目录；本地插件只能在
  profile 的 `node_modules/` 里挂载。
- **改完插件必须开新会话**：bundle 栈是会话 runner 进程启动时读的，当前会话不会重载。
- **Node 会缓存已解析的模块**：同一个包名改完内容，正在跑的宿主可能仍用旧模块；
  判断"到底跑的是哪份代码"要在新会话里重新验证，别信 PID 没变就以为没重载。
- **事故文本本身可能是"没坏"的**：夹具如果复刻得不够狠，测试会给出"未发现缺陷"的
  假绿，所以先拿夹具自己去渲染一遍，确认它真的会红。
