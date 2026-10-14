# 插件设计草案：math-guard（数学渲染守卫）

> 目标：让「数学推导把渲染器搞崩 / 卡死 / 吐原始 LaTeX」这一类翻车不再发生。
> 本文所有接口签名均来自本机 `cordis_inspect_*` 实测，未经验证的部分明确标注。

---

## 0. 先确认故障机制（决定方案上限）

实测本机 `D:\Deepseek\resources\app.asar` 里的前端产物：

| 事实 | 证据 |
|---|---|
| 数学由 **KaTeX 客户端渲染**，字体已内置 | `dsh-web-frontend/dist/assets/fonts/` 下有全套 `KaTeX_*.woff2/woff/ttf`（Main/Math/AMS/Size1-4/Script/Fraktur/SansSerif/Typewriter） |
| 前端是**整包**，没有独立数学 chunk | dist 只有 4 个产物：`index-5SrrfWpU.js` (633 KB)、`vendor-CCJJTK99.js` (740 KB)、`index-BPHePDI_.css`、`vendor-BNsW4eBh.css` |
| 没有任何叫 katex/markdown-it/micromark 的独立模块 | 全库 12967 个文件按 `katex\|mermaid\|markdown-it\|micromark` 只命中字体 |

**结论（决定了设计取向）**：KaTeX 被内联进不可替换的整包 bundle。
→ **不能"换一个更健壮的渲染器"**，也没有 lazy-load 的数学 chunk 可供降级。
→ 唯一可行的路子是：**在数学文本进入 KaTeX 之前把它拦住 / 降级 / 改写**。

也就是说，插件不解决"KaTeX 渲染某公式慢"，而解决"不该进 KaTeX 的东西进了 KaTeX"。

---

## 1. 风险模型

### 1.1 关键洞察：真正的判别信号是「边界污染」，不是「公式复杂」

用本机翻车原文做了对照实验（`math-risk.probe.js` → `math-risk.probe2.js`）：

- v1 只用「公式复杂度」打分：**原稿与重排稿无法区分**（数学相同 → 得分相同，两者都被判 PLAIN）。
- v2 把「公式本身的复杂度」与「公式边界是否被污染」拆开：

| 样本 | 污染块 | 总复杂度 | 判定 |
|---|---|---|---|
| A 原稿（`$$` 粘连正文、`##` 被吞进公式） | **3** | 1.2 | **SOURCE 源码模式** ✅ |
| B 同样数学、重排后 | 0 | 1.1 | **KATEX 直接渲染** ✅ |
| C 合成超大公式（40 项 `\underbrace`，2049 字符） | 0 | 68.2 | **LAZY 懒渲染** ✅ |
| D 12 个合法小公式但很密（9 个/屏） | 0 | 0 | **LAZY 懒渲染** ✅ |

A 号样本的命中项正是原稿的真实病灶——`$$...$$` 的右定界符前面吞进了「初始鼓包被劈成两半，每半高度 $1/2$ ## 第 2 步：写出反射规则 固定端」这一整段正文与标题。

### 1.2 评分函数（两层）

**第一层 · 边界污染（布尔，命中即降级）** —— 扫描数学块**内部**：

```js
const POLLUTION = /(^|\n)\s{0,3}#{1,6}\s|(^|\n)\s*[-*+]\s|(^|\n)\s*\d+\.\s|\*\*|((^|\n)\s*>\s)|\n\n/;
const CJK = /[\u4e00-\u9fff]/;
// 行间公式：命中 Markdown 控制符 / 连续空行 / 中文正文 → 污染
// 行内公式：命中中文正文 → 污染（行内允许少量 CJK 千分位等，可配置白名单）
```

**第二层 · 复杂度（连续量，用于挑懒渲染）**：

- `len > 160` 起计：`(len-160)/50`
- 花括号最大嵌套 `maxBrace ≥ 2`：`(maxBrace-1) × 1.2`
- 重型构造计数 ×0.7：`\underbrace \overbrace \stackrel \substack \begin{cases|aligned|array|matrix|pmatrix|bmatrix|dcases} \displaystyle \xrightarrow \overset \underset`
- 多环境 ×0.4，跨行 +0.2
- **刻意不计 `\big \left \right`**——它们是零成本修饰，v1 把它们计入导致重排稿被误判

**第三层 · 密度**：滑动窗口内相邻 200 字符的公式块数（本机实测重排稿 7/屏、D 样本 9/屏）。

### 1.3 判定与动作

| 判定 | 触发条件 | 动作 |
|---|---|---|
| `SOURCE` | 污染块 > 0 | 该块**完全不送 KaTeX**，按等宽源码展示 + 「尝试渲染」按钮 |
| `LAZY` | 最坏块 ≥ 5，或总复杂度 ≥ 25，或密度 ≥ 8 | 进入视口才渲染；渲染包在 `requestIdleCallback` + 超时里，超时即回落源码 |
| `KATEX` | 其余 | 照常渲染 |

---

## 2. 防御纵深：三层，各挡一类故障

```
① 事前（host）  输出规范注入   → 让模型别产出会炸的排版
② 事中（client）渲染闸门       → 进 KaTeX 前拦截、降级、隔离超时
③ 事后（client）一键降级       → 已渲染的坏帧可手动切回简略版
```

### 第①层 · host：输出规范 + 可选复算工具

已验证接口（本机 `cordis_inspect_query(host, Event, listEvents)`）：

```ts
'system-prompt/assemble'(
  this: Scoped<SystemPrompt>,
  assembly: PromptAssembly,
  context: AssembleContext,
  next: () => Promise<PromptAssembly>
): Promise<PromptAssembly>
```

在 waterfall 里往 `assembly` 追加一节「数学输出规范」（要点：行间公式必须独立成段且前后留空行／不要把标题、正文、`**加粗**` 写进公式体内／超长多行推导请拆成多行公式而不是一个巨型 `aligned`／必要时给纯文本简版）。

同层可选的**硬约束**（比提示词可靠）：

```ts
'agent/pre-step'(
  this: Scoped<Agent>,
  payload: { agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>
): Promise<PreStepDecision>                                  // 可替换进入本步的消息

'agent/request'(
  this: Scoped<Agent>,
  payload: { agent; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<LlmCallConfig>
): Promise<LlmCallConfig>                                    // 可替换本次调用配置
```

> ⚠️ **设计红线**：这两个钩子改的是**进模型的内容**，不是出模型的内容。用它拦"模型输出的坏公式"在时序上不成立——输出已经落库、已经推给前端了。所以第①层只做**事前规范注入**，真正的兜底必须落在前端。想把坏帧挡在库外，只能靠 `present` 之外的正规途径（本轮不做）。

### 第②层 · client：渲染闸门（主力）

已验证接口（`cordis_inspect_query(client, Service|Event|Slots, ...)`）：

```ts
ctx.slots.register(...)                                  // context.slots.register
ctx.slots.inject(key, callback): () => void              // 目标槽位变化时重建注册
ctx.effect(fn)                                           // 注册即返回的清理
ctx.on('theme/change', (snapshot: ThemeSnapshot) => void)
ctx.on('locale/change', (snapshot: LocaleSnapshot) => void)
ctx.on('slots/changed', (key: string) => void)
```

**接入槽位（来自实测的 Slot 树）**：

| 槽位 | 类型 | 用途 | 冲突风险 |
|---|---|---|---|
| `conversation.chat.node` | keyed，key 域**已封闭且不可扩** | ⚠️ **无法**注册新 kind；只能**整体替换** `assistant-step` | 高：`replaceRisk: shadows-shipped-ui` |
| `conversation.chat.assistant-actions` | list | 每条助手消息加「简略版 / 渲染版」切换 | 无（追加项） |
| `settings.section` | list | 插件配置页 | 无 |
| `conversation.input.left` | list | 输入框左侧开关（一键全局降级） | 无 |

> **本节已修正（原先写错了）。** 早先版本说「注册新 kind 安全」。已从 asar 核实：`conversation.chat.node` 的 keyDomain 是**编译期封闭联合** `{ [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }`，共 18 个已占 key（assistant-step, command, command-input, compaction, context, manual-compaction, model-retry, question-reply, steering, system-prompt, tool-call, turn-error, turn-max-tokens, turn-process, turn-tail, turn-trigger, unknown, user, workflow-run）。**插件无法新增 kind**——owner 只按 kind 派发，没有 kind 就永远不会被渲染。因此客户端侧只有两条路：
>
> 1. **整体替换 `assistant-step`**（`replaceRisk: shadows-shipped-ui`）。代价极高：必须自己重实现流式增量 Markdown（含"TeX 在定型前保持字面量"这条规则）、`reasoning` 块与 turnProcess 的折叠/展开联动、图片分组、`groupPart` 分区、interrupted 状态、未知块的 JSON 兜底、以及 locale 标签。
> 2. **不碰槽位**，改在宿主侧修文本（见 §3）——这也与"数据模型不允许预渲染数学"的结论一致：`assistant-step` 的 `data.blocks` 只有 `{kind:"text", text}` / `{kind:"reasoning", text}` / `{kind:"image", attachment}` / `{kind:"tool-call", …}` / `{kind:"other", block}`，**没有 `html` / `segments` / 预渲染字段**，Markdown 只以纯字符串到达渲染器。
>
> 结论：**渲染闸门（render gate）方案作废**，改为宿主侧 `agent/stream-repair`（见 §3 修正）。

**闸门工作流**：

```
消息文本 ──► 收集数学块 ──► 评分 ──► 分发
                                     ├─ SOURCE : <pre> 源码 + 「尝试渲染」
                                     ├─ LAZY   : 占位骨架 ──► 进视口 ──► 空闲渲染(带超时)
                                     └─ KATEX  : 直接渲染
```

**隔离超时**是防"崩"的核心：把渲染放进 `requestIdleCallback`（带 `timeout`）+ `try/catch` + 墙钟预算，超预算就撤掉结果、退回源码并记一条诊断。

### 第③层 · client：一键降级

`conversation.chat.assistant-actions` 加一个动作按钮：把该条消息整体切成"简略版"（源码 / 纯文本数学），并在设置页暴露默认策略（`auto / always-plain / always-render`）。

---

## 3. 纯文本数学的降级渲染（不依赖 KaTeX）

`SOURCE` 模式不是把 `\frac{a}{b}` 直接扔给用户，而是做一个**廉价的 Unicode 近似**：

| LaTeX | 降级显示 |
|---|---|
| `\frac{a}{b}` | `(a)/(b)` 或 `a/b` |
| `\varphi` `\xi` `\alpha` … | `φ ξ α`（符号表，约 60 条） |
| `e^{-2.25}` | `e^(−2.25)`（U+2212 减号） |
| `\ge \le \approx \pm \cdot \times` | `≥ ≤ ≈ ± · ×` |
| `\underbrace{X}_{Y}` | `X  ← Y`（注释上提） |
| `\begin{cases}…` | 逐行 + `{` 前缀 |
| `\text{右行波}` | `右行波` |

这个表**离线可用**，正好复用本机已验证的排版成果（`math-typeset/` 里那份 XeLaTeX 重排稿可作为"高质量版"对照）。
好处：**任何输入都有可读输出**，用户不会看到裸 `\underbrace` 糊成一团。

---

## 4. 配置 schema（草案）

```ts
interface MathGuardConfig {
  mode: 'auto' | 'always-plain' | 'always-render';   // 默认 auto
  maxBlockChars: number;        // 默认 160，超过开始计复杂度
  maxComplexity: number;        // 默认 5，单块超过即 LAZY
  maxTotalComplexity: number;   // 默认 25
  maxDensity: number;           // 默认 8，每屏公式块数
  renderBudgetMs: number;       // 默认 400，单块渲染墙钟预算，超时回落源码
  inlineWhitelist: string;      // 行内公式允许的 CJK 字符（默认空）
  promptRule: boolean;          // 默认 true，向 system prompt 注入输出规范
}
```

---

## 5. 插件骨架（伪代码，接口名已核对）

```ts
// host 半：只做输出规范注入
export const name = 'math-guard';
export function apply(ctx: Context, config: MathGuardConfig) {
  if (config.promptRule) {
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const out = await next();
      out.sections.push({
        id: 'math-guard/output-rules',
        title: '数学输出规范',
        content: MATH_OUTPUT_RULES,     // 见下
      });
      return out;
    });
  }
}

// client 半：【已作废】原方案是注册一个新 kind 'plain-math'。
// 核实后确认 keyDomain 是封闭联合，新 kind 永远不会被派发，故此方案不再成立。
// 客户端侧若仍要干预，唯一可行的是整体替换 assistant-step（需重实现整个块渲染器，见 §2 修正说明）。
ctx.effect(() =>
  ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'assistant-step',                    // 只能复用已有 key，等于接管整条助手消息的渲染
    component: PlainMathAssistantNode,
  })
);
```

`MATH_OUTPUT_RULES` 要点（这是第①层真正要注入的东西，直接对症本机那次翻车）：
1. 行间公式必须**独占一段**，`$$` 前后各留一个空行；
2. 绝不把标题（`##`）、正文、`**加粗**` 写进 `$...$` 内部；
3. 一个 `$$` 块只放一个公式；多行推导拆成多个块，每块一行说明；
4. 单个公式字符数控制在 ~160 以内；超长推导宁可多写几行；
5. `\underbrace{...}_{\text{中文}}` 这类重型标注，**同时**给一份纯文本等价写法；
6. 结尾附「结果读法」用纯文字复述数值，保证即使公式渲染失败也能读懂。

---

## 6. 分期路线

| 阶段 | 内容 | 可验证标准 |
|---|---|---|
| P0 | 评分器独立成模块 + 单测（A/B/C/D 四样本） | 四样本判定与本文一致（已用 `math-risk.probe2.js` 预演） |
> **优先级已按核实结果重排。** 原 P1/P2 依赖"客户端注册新 kind 做渲染闸门"，该前提已被推翻（见 §2 修正），故整体重排如下。

| 优先级 | 做什么 | 验证标准 |
|---|---|---|
| **P0（前置，必须先做）** | 用一个最小插件验证**宿主侧能否在持久化前改写助手文本流**（`'llm/stream'` waterfall 的块形状；改写后是否同时进入 `assistant/live-chunk` 与 `assistant/message`） | 改写一个 token 后，**对话里和会话文件里都变了**。这决定宿主侧方案成不成立 |
| **P1** | 宿主侧 `system-prompt/assemble` 注入 `MATH_OUTPUT_RULES` | 同样提问下，坏排版（`$$` 内混入标题/正文）出现率下降；做 A/B 对比 |
| **P2** | 宿主侧流式修复：校验 `$$` 配对、把 Markdown 结构字符从数学块里摘出来、补空行 | 喂本机原稿那段文本 → 不再出红块 |
| ~~P3~~ | ~~client 渲染闸门（SOURCE / LAZY / 超时回落）~~ | **作废**：无可用槽位；替换 `assistant-step` 的代价（重实现整个块渲染器）远高于收益 |
| **P4（可选）** | `conversation.chat.assistant-actions` 加一个"简略版"切换 | 纯追加项，风险低；可作为独立小功能，不依赖上面的前提 |

> 注：KaTeX 异常确实逃不出 `renderTexToReact`，所以"隔离超时防白屏"防的是一个**不存在**的故障；超时机制最多用来治理**布局爆炸导致的卡顿**，优先级低于语法修复。

---

## 6.5 插件落地契约（已核实，实现时直接照抄）

**最小文件集：四个文件**（模板 `templates/decoration/` 实测）——`package.json` / `index.js`（宿主半，可空）/ `client.js`（客户端半）/ `cordis.patch.yml`。**不需要** locale 文件，**不需要** `peerDependencies`（整个 `skills/cordis-plugin-development` 里 grep `peerDependencies` 零命中）。

`package.json` 形状：

```json
{
  "name": "@local/math-guard",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

**`dsh` 清单只有三个公开域**：`manifestVersion` / `bundle.patch` / `client`。全 asar 搜索 `x-prompt-sections`、`x-tool-namespaces`、`x-components`、`x-prompt`、`x-facets` **全部零命中**——不存在"声明式贡献提示词/组件"这条路，提示词必须走宿主 JS 的 `system-prompt/assemble`。另外「兼容性是声明式的」：`dsh.manifestVersion` 与 `engines.dsh` **当前安装器/加载器并不强制校验**，写错也不会被拒。

`client.js` 注册形式（React 从平台模块表取，**不要打包 React**）：

```js
window.__ModuleLoader__.load({
  id: '@local/math-guard',
  factory(require) {
    const React = require('react');
    return {
      inject: ['slots'],
      apply(ctx) { ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node', key: 'assistant-step', /* … */
      }, Component)); },
    };
  },
});
```

**五条硬约束（官方 `references/verification.md` 与 `ui-plugin.md`，违反会被判不合规）：**

1. **不得自行安装**：装/卸一律走 `plugin_manager` 工具（`install_bundle` / `list_plugins` / `list_bundles` / `set_plugin` / `set_bundle` / `remove_bundle`），不要用 shell 复现安装步骤。
2. **不得为了"看效果"另开浏览器**：不许改 `HOME`、不许翻真实浏览器配置、不许找 token、不许搜光栅化工具或提取 SVG 做预览。**"没有浏览器控制权时，验证只到 JS 语法、清单校验、live Client slot 三项为止，并如实报告视觉验证不可用"。mock 页面的截图不算验证。**
3. `apply` 内用 `ctx.effect` / `ctx.on` 注册样式、定时器、监听器并返回清理函数；**不要替换 app 根节点，不要往 `document.body` 追加第二个应用**。
4. 不要读别的插件的 DOM/CSS/组件源码来"估算位置"；选一个已经分配好空间的槽位。
5. `failed` 需诊断，`overridden` 表示被更高优先级层覆盖，`restart-required` 表示未生效；**不要从"slot id 没变"推断浏览器代码没更新**。

**已复用的现成工具**：`_asar\asar.py`（`list` / `cat` / `grep <pat> <dir> <limit>` / `slotscan` 子命令），用捆绑 Python 跑；**必须先设 `PYTHONIOENCODING=utf-8`**，否则 `grep` 会因 GBK 编码崩掉。

---

## 7. 已核实 / 仍未验证（诚实清单）

**已核实并据此改设计了（原先的猜测被推翻）：**

1. ~~客户端或宿主侧存在可挂载的数学渲染钩子~~ → **没有**。全 asar 只有一个 `katex.renderToString` 调用点（`dsh-client-ui-primitives/lib/index.js`，`function renderTexToReact` 定义出现 **1** 次，`katex.renderToString` 出现 **2** 次，都在它内部）。KaTeX 未暴露、不可配置。
2. ~~可以注册新的 ChatNode kind 做渲染闸门~~ → **不行**，keyDomain 是封闭联合（见 §2 修正）。客户端唯一干预手段是整体替换 `assistant-step`。
3. **ChatNode 载荷形状**（原第 2 条，现已取到）：`assistant-step` 的 `data = { status, turn, step, blocks, time, usage?, finalNode? }`，`blocks` 元素仅五种：`{kind:'text',text}` / `{kind:'reasoning',text}` / `{kind:'image',attachment}` / `{kind:'tool-call',callId,name,argsRaw}` / `{kind:'other',block}`。**无 `html`/`segments`/预渲染字段**。
4. KaTeX 选项（原第 5 条，现已取到）：生效值恰为 `{displayMode, throwOnError:true}`，失败后重试 `{displayMode, strict:'ignore', throwOnError:false}`。`errorColor` / `maxExpand` / `maxSize` / `trust` / `macros` **全部从未传入**——`errorColor` 因此是 KaTeX 默认 `#cc0000`。`maxExpand` 默认 1000、`maxSize` 默认 `Infinity`。
   - **对设计的影响**：既然异常逃不出 `renderTexToReact`（两层 try/catch + 兜底 span），"隔离超时"防的是**布局爆炸导致的卡顿**，不是白屏。P2 的优先级可以下调。
5. 数学渲染只在**定型时**发生：`parseGfm`（流式）用 `gfm` 扩展，定型用带 `math()` 的语法；块级公式那一支还带 `!context.streaming` 守卫。所以流式全程公式是字面文本，收尾时**一次性同步渲染**整条消息。`\(...\)` 仅在定型语法中被识别，会造成"流式显示字面量、定型后突然变公式"的跳变。

**仍未验证：**

1. **能否在宿主侧于持久化之前改写助手文本流**：`'llm/stream'` waterfall 的返回块形状、以及改写后的文本是否同时进入 `assistant/live-chunk`（瞬态，分数 seq）与 `assistant/message`（持久）两条路径——这是整个宿主侧方案的**前提**，必须先用一个最小插件验证。
2. `PromptAssembly` 的确切字段（`sections`/`contexts`/`tools`/`variables`）与追加方式未取到契约。
3. client 动态半可用的 UI 原语（`client/Builtin`）未查——是否只有受限内建组件集。
4. 宿主侧是否存在消息文本长度上限（若有，超长消息可能被截断在 `$$` 中间，从而**制造**本次要修的那种故障）。

---

## 附：本次侦察留下的可复用工具

- `plugin-design/list-asar.js`：零依赖解析 Electron `app.asar` 头部并检索文件（用法 `node list-asar.js <app.asar> <正则> [条数]`）。
  - 踩坑记录：asar 头是 pickle（8 字节前导 + 4 字节长度 + JSON），**不能用 NUL 找结尾**（头部可能 >4 MB），必须按声明长度切片或做括号配平。
- `plugin-design/math-risk.probe.js` / `math-risk.probe2.js`：风险评分对照实验（v1 失败 → v2 成功，见 §1.1）。
