# 数学渲染防护插件 —— 实测结论与设计方案

> 本文所有结论都在**本机真实环境**上跑过，不是推断：
> KaTeX `0.16.47`（`%USERPROFILE%\.dsh\profiles\desktop\node_modules\katex`），
> 复现脚本 `katex-stress.js` / `katex-personas.js` / `repair-math.js`。
> 所有数字都是脚本输出，可重跑复验。

---

## 0. 先纠正两个前提：**没有崩溃**，而且红块是 DSH **故意设计**的兜底

原对话的判断是「LaTeX 编译过于复杂导致渲染器崩溃」。我把这条判断拿去查了代码和崩溃日志，**两半都不成立**。

### 0.1 查代码：DSH 的数学渲染有三层兜底，异常根本出不来

前端 chunk 里的 `renderTexToReact(value, displayMode)`（已从 `app.asar` 抽出，见 `mathfind/primitives.js`）：

```js
try { html = katex.renderToString(value, { displayMode, throwOnError: true }); }
catch (error) {
  try { html = katex.renderToString(value, { displayMode, strict: "ignore", throwOnError: false }); }
  catch { /* v8 ignore next 8 */
    return jsx("span", { className: "katex-error", style: { color: "#cc0000" }, title: String(error), children: value }); }
}
```

三层依次是：

| 层 | 配置 | 结果 |
|---|---|---|
| 1 | `throwOnError: true` | 正常渲染；坏输入则抛 `ParseError`，被 **catch 住** |
| 2 | `throwOnError: false, strict: "ignore"` | 把**原始源码**用 KaTeX 排版 + 红字 |
| 3 | 两层都抛 | 一个红色 `katex-error` span，`children` 就是**原始 value** |

**关键：三层的出口都是"红色 + 原始源码"，没有任何一条把异常抛给 React。** 所以你截图里那团红字**不是崩溃现场，而是兜底层的正常输出**——它是被设计成这样的。第 3 层的注释 `/* v8 ignore next 8 */` 说明维护者认为这条路径几乎跑不到。

### 0.2 查日志：没有渲染器崩溃记录

搜遍 `%USERPROFILE%\.dsh\`（sessions、logs）、`AppData\Roaming\@deepseek-ai\dsh-desktop\`（crash logs、logs、Local Storage）、`%TEMP%`、Crashpad，用 `katex|ParseError|Maximum call stack|RangeError|heap out of memory|GPU process|Uncaught` 逐条筛。

**没有任何渲染器崩溃的证据。** 四份 crash log **全部是 `source: host`**，同一条错误：

```
Error: dsh desktop host exited with 1073807364
  at file:///D:/Deepseek/resources/app.asar/lib/main.js:3724:64
  (electron 44.0.0, node 24.18.1, app 0.2.0-rc.2, zh-CN)
  files: logs\crash-2026-10-03T06-14-22-428Z-host.log, crash-2026-10-07T15-35-39-055Z-host.log (0 B),
         crash-2026-10-08T16-10-08-824Z-host.log, crash-2026-10-13T16-18-33-687Z-host.log
```

`1073807364` = `0x40010004` = `STATUS_CONTROL_C_EXIT` —— **宿主在退出时被正常终止**，不是渲染故障。

整个环境里唯一的渲染器 console 记录是两条无关的：`[dsh-better-sidebar] agent-opens connection failed; stopping reconnect loop` 和 `[dsh-pet] 余额查询失败 reason=fetch-error`。

### 0.3 回到现场：助手自己当时也只是在猜

会话 `session-d7c78d3f-06cf-4add-95f3-aa4fa9400ef9`：用户 seq 1233 说「输出的是红色高亮的半成品，包含输出内容与代码」。助手 A#1235（标题就叫《为什么会出现"红色高亮的半成品"》）自己的解释是：

> 这是**渲染阶段的失败**，不是内容丢失…前端把部分内容当成了未闭合结构，于是从出错位置开始整段变成异常样式（红色/高亮/半成品）

并点名触发物：三反引号代码围栏、`\begin{cases}`、`\boxed{}` 与 `$` 嵌套。

**"渲染器崩溃"出现在更早的 A#1226 里，是它列的五种猜测中的第三种，从未被观测到。**

### 0.4 所以真正的问题是什么

| 原判断 | 修正后 |
|---|---|
| LaTeX 编译过于复杂 | ❌ 与复杂度无关，是**一处语法级错误**（Markdown 漏进了数学模式） |
| 渲染器崩溃 | ❌ 没有崩溃；是**设计好的红色兜底**被触发 |
| 非 LaTeX 简版就能正常生成 | ✅ **这条成立**，但原因不是"编译简单"，而是**格式约束对了**：简版没有把 Markdown 塞进 `$$` |

**真正要修的是一个内容/语法问题（PARSER 类），不是一个性能或稳定性问题。** 这反而让插件更好做：不需要去碰渲染性能，只需要保证喂给渲染器的字符串是**语法正确**的。

**红块的大小只取决于模型把多少东西塞进同一个 `$$`，与数学的复杂度无关**——这是设计里最重要的一句话。

> 仍保留的一项次要风险：`maxSize` 默认 `Infinity`、`maxExpand` 默认 `1000`（见 §2 的完整默认值表），超大结构确实能造成 91× 的 DOM 膨胀。但它表现为**卡顿**，不是崩溃，优先级低于语法修复。

---

## 1. 真正的触发点：Markdown 漏进了数学模式

我拿截图里的真实片段做了对照实验：

```
输入：\underbrace{\tfrac12\varphi(x-t)}_{\text{右行波 }F} ## 第 2 步：写出反射规则
输出：✗ ParseError: Expected 'EOF', got '#' at position 50  ← 卡在 "##"
```

而同一段，**只要把中文包好、去掉 `##`，就完全正常**：

| 输入 | 结果 | 耗时 |
|---|---|---|
| `\text{右行波 }F`（中文在 `\text{}` 里） | ✅ 正常渲染，输出 9065 字符 | 8.7 ms |
| `\text{right }F`（同结构纯 ASCII） | ✅ 正常渲染，输出 8982 字符 | 2.9 ms |
| `## 在数学模式内` | ❌ ParseError | 0.1 ms |
| `**Markdown 加粗** 在数学模式内` | ⚠️ 能解析，但语义错（变成了乘号） | 0.3 ms |
| 裸中文写在数学模式内（无 `\text`） | ⚠️ 不报错，只发 `unicodeTextInMathMode` 警告 | — |

**四条可直接用于设计的结论：**

1. **中文进 `\text{}` 是合法的、被官方支持的**，8.7 ms 就渲染完了，`\text{右行波}` 根本不是问题。
2. **真正的杀手是 `##`**：它是模型把 Markdown 标题写进了 `$$` 里。`#` 在数学模式里直接让解析器停摆。
3. `**` 更阴险：**它不报错**，于是既不红也不崩，而是静默地把加粗渲染成一串乘号——这种错用户很难发现。
4. 中文一旦**裸写**在数学模式里，只发警告不报错；一旦字体链缺 CJK 字形，就变成豆腐块——所以"包 `\text{}`"依然要做，但属于**加固**而非救火。

---

## 2. 崩溃路径（B）确认存在，且默认配置就踩在雷上

KaTeX 的四个关键默认值（读自 `Settings.ts`）：

| 选项 | 默认值 | 含义 |
|---|---|---|
| `throwOnError` | **`true`** | **默认就抛异常** |
| `errorColor` | `#cc0000` | 红块的红色；截图里那个红就是它 |
| `strict` | `false` | 非 LaTeX 输入不报 |
| `maxSize` | **`Infinity`** | **尺寸完全不设上限** |
| `maxExpand` | `1000` | 只限制**宏展开次数**，不限制别的 |

实测 `throwOnError: true` 喂进同一段坏输入：

```
✗ 抛出 ParseError
  message : KaTeX parse error: Expected 'EOF', got '#' at position 50
  position: 49   rawMessage 存在
```

所以：**同一个 bug，换个 KaTeX 配置就从"红字"变成"抛异常"。** 任何针对这个问题的防护，都必须同时覆盖两条路径。

---

## 3. 没被考虑到的方向：真正的内存炸弹不在"列数"上

我原本以为风险来自"超宽矩阵"。实测下来，**宽矩阵反而很温和，嵌套 `\frac` 才是指数级炸弹**。

### 3a. 宽矩阵：线性增长，20 ms 级，不致命

| 列数 | 输出 HTML | `<span>` 节点数 | 耗时 |
|---|---|---|---|
| 50 | 31 KB | 707 | 11 ms |
| 500 | 308 KB | 7 007 | 25 ms |
| 2000 | 1.23 MB | 28 007 | 50 ms |

### 3b. 嵌套 `\frac`：**每层放大约 91 倍**，16 层直接爆栈

| `\frac` 嵌套深度 | 输入长度 | 输出 HTML | 放大倍数 | 耗时 |
|---|---|---|---|---|
| 5 | 311 字符 | 28.9 KB | 92.9× | 3 ms |
| 10 | 10 231 字符 | 933 KB | 91.2× | 32 ms |
| 12 | 40 951 字符 | 3.73 MB | 91.2× | 136 ms |
| 14 | 163 831 字符 | **14.9 MB** | 91.1× | 614 ms |
| 16 | 655 351 字符 | — | — | **抛 `RangeError: Maximum call stack size exceeded`** |

**这是本方向最重要的发现：**

- 放大率**恒定 ~91×**，所以输入每加一层就翻倍——10 层输入 10 KB，14 层输入 164 KB，**15 层以上模型随手就能写出来**（`\frac{\frac{\frac{...}}}` 是模型的常见写法）。
- 14 层 = 15 MB HTML ≈ 数万个 DOM 节点，浏览器主线程直接卡死（`maxSize: Infinity` 拦不住它，`maxExpand: 1000` 也拦不住它——**这两个护栏都不管结构嵌套**）。
- 16 层 = **KaTeX 自己抛栈溢出**，这又是一条崩溃路径。
- 代价对比极不对称：输入 164 KB 就能换到 15 MB 的 DOM，**放大约 91 倍**。

> 顺带排除一个伪风险：30 层下标链（`x_0_1_...`）只产生 229 字符 HTML，完全无害。

---

## 4. 修复函数的原理验证（已跑通）

我在 `repair-math.js` 里把"流式修复"写成确定性函数并验证，**核心要求是不产生误伤**：

```
=========== 幂等性与误伤检查 ===========
  ✓ 未改动  ✓ 可渲染   u=\tfrac12[\varphi(x-t)+\varphi(x+t)]
  ✓ 未改动  ✓ 可渲染   \text{右行波 }F
  ✓ 未改动  ✓ 可渲染   \begin{cases} a & x\ge t \\ b & x<t \end{cases}
  ✓ 未改动  ✓ 可渲染   \varphi(z)=e^{-z^2}
  ✓ 未改动  ✓ 可渲染   \tilde\varphi(\xi)=-\varphi(-\xi)\ (\xi<0)
```

**5/5 正确公式一字未动，`\text{}`/`\operatorname{}`/`\mathrm{}` 内的中文一律不被二次包裹。** 这是最关键的验收指标：修复器绝不能把好公式改坏。

同时也暴露了一个**必须在设计里写明的陷阱**：朴素地"把裸 CJK 包进 `\text{}`"会产出**语法合法但语义错误**的结果：

```
\underbrace{...}_{\text{右行波 }F} ... \text{第}\text{步：写出反射规则}\text{固定端}...
```

它能通过 KaTeX 校验（所以校验器拦不住它！），但把本应移出数学模式的**正文**变成了公式里的文字标签。**结论：必须先判断"这是漏进来的正文"并把它移出 `$$`，再谈包裹；只做包裹会制造一个更隐蔽的错误。** 这条正是"没考虑到的方向"里最值得记的一个。

---

## 5. 插件方案：三条腿，按"能不能兜住"排序

### 第 1 条腿（地基）：提示词约束 —— 直接消灭成因，零运行时成本

用清单里已经验证存在的**声明式** `x-prompt-sections`（不用写一行 Host JS）加一节硬规则。规则必须是从实测反推出来的，而不是泛泛的"请写好 LaTeX"：

1. **`$$` 里只放数学**，绝不放标题、正文、列表、`##`、`**`。
2. 一段推导**拆成多个短 `$$`**，每个 `$$` 只表达一步。（这一条同时把路径 A 的红块从"整段"压到"一行"，把爆炸半径降到最小。）
3. 中文一律进 `\text{...}`，**不要裸写**。
4. **`\frac` 嵌套不超过 3~4 层**，超过就引入中间变量 $a=\dots$ 分步写。
5. 不要用 KaTeX 不支持的命令（`\begin{align}`、`\substack` 的某些用法、自定义宏等）。

### 第 2 条腿（兜底）：Host 侧流式修复 —— 这是真正的护栏

事件面已经查清，**存在一个完美的挂点**：

```
'llm/stream'(this: LlmRuntime, options: GenerateOptions,
             next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

这是**围绕每一次流式模型调用的 waterfall**，可以直接包住返回的异步迭代器。配合 chunk 结构：

```
StreamChunk =
  | { type: 'text-delta';      index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'block-end';       index: number; block: ContentBlock }
  | { type: 'finish';          reason: FinishReason; replayState?: ReplayEnvelope }
  | ...
```

插件要做的事：按 `index` 累积 `text-delta`，维护"当前是否在 `$$` 内"的状态机；**当一个数学块闭合时**，先跑修复再决定放行：

```
闭合的数学块
  ├─ 用真实 KaTeX 校验（host 进程里就能 require 到 katex 0.16.47）
  ├─ 不通过 → 剥 Markdown → 包 CJK → 必要时把正文行移出 $$ → 重新校验
  ├─ 仍不通过 → 降级：整块替换为一行折叠提示（绝不把非法 LaTeX 放给前端）
  └─ 通过 → 放行
```

三个必须写进设计的工程点：

- **延迟成本可控**：只缓冲数学块（`$$…$$` 区间），区间外的正文照常逐字流出，不牺牲打字机观感。
- **护栏必须双向**：既拦 `ParseError`（路径 B），也拦 `91×` 放大（输入长度/嵌套深度/预估输出规模三个阈值，超限就拒绝渲染并给出提示）。
- **校验器要用 host 侧的 KaTeX，且 `strict:'ignore'`**，判定标准是"不抛 ParseError"，避免把 warning 误判成错误。

### 第 3 条腿（界面）：能兜住"抛异常"，兜不住"红块"；前端无法配置 KaTeX

**先看一个已装插件的现成先例。** `dsh-better-sidebar@0.24.1`（本机已安装）里有：

- `src/client/RenderBoundary.tsx` —— 一个标准 React 错误边界：

```tsx
export class RenderBoundary extends Component<{ children?: ReactNode; className?: string }, { error: string | null }> {
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  render(): ReactNode {
    if (this.state.error !== null) return (<div>...错误条 + 重试按钮...</div>)
    return this.props.children
  }
}
```

  它的注释明确写了用途："a crashing viewer/editor shows a strip inside ITS OWN pane; the workbench shell, the other tabs, and the panel itself stay alive"——**"渲染崩溃不要让整个 shell 陪葬"这件事，这个插件已经用错误边界解掉了。**

- `src/client/MarkdownHtml.tsx` —— **直接 `import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'`**，也就是官方文档警告"不要在插件里导入"的那个包。

**对插件设计至关重要的两点：**

1. **`MarkdownText` 只接受 `text` 和 `labels` 两个 prop**（见 `src/client/markdown-labels.tsx` 的 `markdownTextProps()`）。**没有任何 `throwOnError` / `errorColor` / `strict` / `maxSize` 的入口。** KaTeX 的配置被封在 `dsh-client-ui-primitives` 内部，调用方无法覆盖。这意味着：**前端既无法让红块出现，也无法让它消失——它连 KaTeX 都碰不到。**

2. **错误边界只能接住"抛出的异常"，接不住"优雅降级"。** `throwOnError: false` 时 KaTeX 返回的是一个**成功的** React 元素（红色内容），根本不触发 `componentDidCatch`。所以：

| | 错误边界能兜住吗 |
|---|---|
| 路径 B：`throwOnError: true` → 抛 `ParseError` | ✅ 能（`getDerivedStateFromError` 接住，降级成一条错误条） |
| 路径 A：`throwOnError: false` → 红块 | ❌ **不能**（这是正常渲染结果，边界看不到） |
| 91× DOM 爆炸 → 主线程卡死 | ❌ 不能（不是异常，是卡死） |
| `RangeError: Maximum call stack size exceeded` | ✅ 能（是异常） |

**结论：第 3 条腿保留，但只作为"异常兜底"，而且它是唯一能防"整页白屏"的东西**——成本极低（照抄 40 行错误边界）、价值明确，但**不要指望它解决截图里的红字问题**。

至于整块替换 `conversation.chat.node` 的 `assistant-step` 渲染器：技术上可行，但要自己重新实现流式状态、思考块、工具调用分组、复制按钮、token 计数一整套，**而且换掉渲染器也不会改变 KaTeX 的行为**（只要能拿到 `MarkdownText`，配置还是封死的）。**收益为零，成本极高 → 不做。**

---

## 6. 拦截点定论：`llm/stream` 是唯一且**足够**的位置

原本担心"修好了实时显示、历史回看还是坏的"。查证宿主实现后，**这个缺口不存在**——修在 `llm/stream` 上，一次改写同时喂给三个下游。

宿主里每一路 chunk 的分发点（`dsh-agent-loop` 的 `push(chunk)`）：

```js
/** Snapshot one chunk once, then feed durable compaction, assembly, and live publication. */
push(chunk) {
  const timed = this.accumulator.push({ time: Date.now(), chunk });
  this.assembler.push(timed.chunk);        // ① 组装成durable消息体
  this.emit({ type: "chunk", ... });       // ② 推给客户端实时显示
}
```

三个下游全部由**同一个 chunk**派生：

| 下游 | 代码路径 | 是否被改写影响 |
|---|---|---|
| ① 持久化消息体 | `createAssistantMessage({ content: live.blocks(), ... })` → `session.append("assistant/message", ...)` | ✅ 是（`blocks()` 来自 `assembler`） |
| ② 客户端实时流 | `agent/assistant-stream` 帧 → WebSocket `/api/remote.mux` | ✅ 是 |
| ③ 实时快照/压缩 | `live.push(chunk)` 的同一 snapshot | ✅ 是 |

而 `llm/stream` 确实在这条链的上游（`dsh-llm`）：

```js
streamWithRegistration(options, prepared) {
  return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
}
```

**存在可用的先例**：`dsh-session-checkpoint-policy` 就用 `ctx.on(...)` 返回替换后的流（`lib/index.js:61-64`）并解析 session。

**所以设计定论：宿主侧 `llm/stream` 拦截 = 改一处、三处生效。** 持久化、实时显示、历史回看一次全治。

### 两条实测出来的防护要求（写进实现）

- **客户端每帧都在重建整串文本**：`blocks[chunk.index] = { kind:"text", text: (previous?.text ?? "") + chunk.text }`，且每次发布都把**全新的 `text` 字符串**交给 `MarkdownText`。所以要**把修复做在宿主**，让前端收到的本来就是合法字符串。
  - **更正（原稿在这里写错了一句）**：我先前据子代理报告写过"每帧重解析整篇、长回复是 O(n²)"。**这条是错的。** 已核实出厂代码里有专门的增量解析器：`IncrementalMarkdownParser`（`primitives.js:10180`，注释在 `:10054` 明说"Re-parsing the whole accumulated document on every streaming chunk is quadratic in the final reply length"，即这个二次开销是被**刻意设计掉的**），配合 `StreamingRenderer`（`primitives.js:11711`）持有的 `frozenCount` / `frozenElements`（`:11715`）冻结已完成块。
  - 真正的代价在**收尾**：`!context.streaming` 时走 `renderSettled`（`primitives.js:11680`），对整个文档做**一次**全量解析 + 逐节点建 React 树。这是 **O(n) 但同步**的一次性开销——够长够密的公式可能造成一次收尾卡顿，但**不是** O(n²) 灾难。
- **没有任何针对助手文本的体积上限**（这条结论成立，但论据要换）：`MAX_CHARS = 2e4` 出现在两处，**都不是助手消息文本**——`dsh-client-ui-chat/lib/client.js:358` 的注释写明是 `/** Model-facing text stays bounded at the disclosure, not at the producer. */`（作用于 ContextBody 的展示），另一处是 `primitives.js:12009` 的 `JsonBlock` 显示。而那个看似最相关的 `markdown.truncatedCharacters`（"…truncated at {total} characters"）**全 asar 只出现在 locale 定义里（`dsh-client-locale/lib/client.js:968` 与 `:1014`），零处调用**，是条死字符串。
  - 也就是说：**助手 Markdown 文本不会被截断**，不存在"截断把 `$$` 切一半"这种故障来源——本来要防的那类故障不是这么来的。
  - 但**输入侧仍然不设防**（历史分页 `DEFAULT_MAX_MESSAGES = 50` / `HISTORY_PAGE_OPTIONS.maxMessages: 500` 只限制条数），所以第 2 条腿的自有护栏（嵌套深度/长度/预估输出）仍是必需项。

---

## 7. 建议的落地顺序

1. **先做第 1 条腿**（提示词约束）。零成本、立刻见效、直接砍掉成因，而且能独立验证：同一道题重问一次，看还会不会出现 `$$` 里带 `##`。
2. **第 3 条腿的错误边界顺手加上**（照抄 `dsh-better-sidebar` 的 40 行）。它是唯一能防"整页白屏"的东西，成本几乎为零。
3. **再做第 2 条腿的最小可用版**：只做"校验 + 拒绝降级"，先不做自动修复。这一步就能同时消灭路径 A 和路径 B——最差也只是退化成一行提示，不会再出现满屏红字或白屏。
4. **最后加自动修复**（剥 Markdown / 包 CJK / 拆块），并用 §4 那组"5/5 不许改动"做回归测试。
5. **爆炸护栏**（嵌套深度、输入长度、预估输出规模）与第 3 步同期上，它比语法错误更容易造成真崩溃。

---

## 附：复现命令

```powershell
# 现象复现与阈值测量（宽矩阵、嵌套 frac、宏展开、各类语法错误）
node plugin-design\katex-stress.js

# 两种"人格"（抛异常 vs 红块）与放大曲线
node plugin-design\katex-personas.js

# 修复函数的误伤/幂等回归测试
node plugin-design\repair-math.js
```
