// math-risk.probe.js — 验证「数学块风险评分」启发式：用真实翻车样本 + 正常样本对照
// 思路：单个公式的渲染代价近似正比于 (原子数) × (嵌套深度)，再加"一屏公式密度"。
// 评分只需便宜、单调、可解释，不追求精确。

const RISKY = /\\underbrace|\\overbrace|\\stackrel|\\substack|\\begin\{(cases|aligned|array|matrix|pmatrix|bmatrix|dcases)\}|\\big[lrm]?|\\left|\\right|\\displaystyle|\\text\{|\\xrightarrow|\\overset|\\underset/;
const ENV = /\\begin\{([a-zA-Z*]+)\}/g;

function stripFences(md) {
  return md.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
}

/** 收集所有数学块：$$...$$ / \[...\] / $...$ / \(...\) */
function collectMath(md) {
  const src = stripFences(md);
  const out = [];
  const push = (start, end, body, display) => out.push({ start, end, body, display });
  const displayRe = /\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g;
  let m;
  while ((m = displayRe.exec(src))) {
    const body = m[1] !== undefined ? m[1] : m[2];
    const off = m[1] !== undefined ? 2 : 2;
    push(m.index, m.index + m[0].length, body, true);
  }
  const inlineRe = /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)|\\\(([\s\S]*?)\\\)/g;
  while ((m = inlineRe.exec(src))) {
    const body = m[1] !== undefined ? m[1] : m[2];
    push(m.index, m.index + m[0].length, body, false);
  }
  return out;
}

/** 单块风险：长度 + 嵌套深度 + 危险构造 + 环境数 */
function scoreBlock(body, depth) {
  const reasons = [];
  let score = 0;

  const len = body.length;
  if (len > 120) { score += (len - 120) / 40; reasons.push(`len=${len}`); }

  let maxBrace = 0;
  for (let i = 0, d = 0; i < body.length; i++) {
    if (body[i] === "{") { d++; if (d > maxBrace) maxBrace = d; }
    else if (body[i] === "}") d--;
  }
  if (maxBrace >= 2) { score += (maxBrace - 1) * 1.5; reasons.push(`braceDepth=${maxBrace}`); }

  const risky = body.match(new RegExp(RISKY.source, "g"));
  if (risky) { score += risky.length * 0.6; reasons.push(`risky=${risky.length}(${[...new Set(risky)].slice(0, 3).join(",")})`); }

  const envs = body.match(ENV);
  if (envs && envs.length > 1) { score += envs.length * 0.5; reasons.push(`env=${envs.length}`); }

  if (depth > 0 && len > 60) score += 0.5;                      // 行内长公式
  if (body.includes("\n")) score += 0.3;                        // 跨行

  return { score: Math.round(score * 10) / 10, reasons };
}

function analyze(markdown) {
  const blocks = collectMath(markdown);
  const scored = blocks.map((b) => ({ ...b, ...scoreBlock(b.body, 0) }));

  // 一屏密度：相邻 200 字符内的公式数量
  let density = 0;
  for (let i = 0; i < scored.length; i++) {
    let n = 1;
    for (let j = i + 1; j < scored.length && scored[j].start - scored[i].start < 200; j++) n++;
    if (n > density) density = n;
  }

  const total = scored.reduce((a, b) => a + b.score, 0);
  const worst = scored.reduce((a, b) => Math.max(a, b.score), 0);
  const verdict = worst >= 4 ? "PLAIN" : total >= 12 || density >= 6 ? "LAZY" : "KATEX";

  return { count: scored.length, total: Math.round(total * 10) / 10, worst, density, verdict, scored };
}

// ---------- 样本 ----------

// 样本 A：真实翻车的那段推导（截取核心部分，保留原样：无空行、标题粘连、超长公式行）
const SAMPLE_BAD = String.raw`=\underbrace{\tfrac12\varphi(x-t)}_{\text{右行波 }F}+\underbrace{\tfrac12\varphi(x+t)}_{\text{左行波 }G}$ 初始鼓包被劈成两半，每半高度 $1/2$ ## 第 2 步：写出反射规则 固定端 $u(0,t)=0\Rightarrow$ 对初值作**奇延拓** $\tilde\varphi(\xi)=-\varphi(-\xi)$，于是
$$u(x,t)=\frac{\tilde\varphi(x-t)+\varphi(x+t)}{2}=\begin{cases} \tfrac12\big[\varphi(x-t)+\varphi(x+t)\big], & x\ge t\\[8pt] \tfrac12\big[-\varphi(t-x)+\varphi(x+t)\big], & x<t \end{cases}$$ 每点的算法只有两步：查 $x-t$、$x+t$ 两处的初值；
**$t=1.5$（反射波已返回，$x-t=-0.5<0$，需反射）**：$u=\tfrac12[-\varphi(0.5)+\varphi(2.5)]=\tfrac12[-e^{-2.25}+e^{-0.25}]=\tfrac12[-0.105399+0.778801]=0.336701$$`;

// 样本 B：同样数学内容，但按建议格式排版（空行分段、公式独占行、逐行推导）
const SAMPLE_GOOD = String.raw`## 第 2 步：写出反射规则

固定端 $u(0,t)=0$，对初值作**奇延拓** $\tilde\varphi(\xi)=-\varphi(-\xi)$（$\xi<0$）。

于是

$$
u(x,t)=\frac{\tilde\varphi(x-t)+\varphi(x+t)}{2}
$$

分两种情况：

$$
u(x,t)=
\begin{cases}
\tfrac12\big[\varphi(x-t)+\varphi(x+t)\big], & x\ge t\\[4pt]
\tfrac12\big[-\varphi(t-x)+\varphi(x+t)\big], & x<t
\end{cases}
$$

$t=1.5$ 时 $x-t=-0.5<0$，需反射：

- 第一项：$-\tfrac12\varphi(0.5)=-\tfrac12 e^{-2.25}=-0.052699$
- 第二项：$\tfrac12\varphi(2.5)=\tfrac12 e^{-0.25}=0.389400$

求和得 $u=0.336701$。`;

for (const [label, text] of [["A 原稿（翻车排版）", SAMPLE_BAD], ["B 重排后（同样数学）", SAMPLE_GOOD]]) {
  const r = analyze(text);
  console.log(`\n=== ${label} ===`);
  console.log(`公式块 ${r.count} 个 | 总风险 ${r.total} | 最坏单块 ${r.worst} | 密度 ${r.density}/屏 -> 判定 ${r.verdict}`);
  r.scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .forEach((s) => console.log(`   score=${s.score} ${s.display ? "[行间]" : "[行内]"} ${s.reasons.join(" ") || "-"} :: ${s.body.slice(0, 46).replace(/\n/g, "⏎")}…`));
}

// 合成对照组：单个巨大 underbrace 表达式（模拟"渲染器崩溃"级输入）
const MONSTER = "$$" + Array.from({ length: 40 }, (_, i) => `\\underbrace{\\frac{a_{${i}}}{b_{${i}}}}_{\\text{term }${i}}`).join("+") + "$$";
const r = analyze(MONSTER);
console.log(`\n=== C 合成超大公式（40 项 underbrace）===`);
console.log(`公式块 ${r.count} 个 | 总风险 ${r.total} | 最坏单块 ${r.worst} | 密度 ${r.density}/屏 -> 判定 ${r.verdict}`);
