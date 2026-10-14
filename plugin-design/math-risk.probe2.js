// math-risk.probe2.js — 修正版：把「公式本身有多重」与「公式边界是否被污染」分开
// v1 的教训：单看公式复杂度无法区分原稿与重排稿（两者数学相同），
//            真正的判别信号是 —— 数学块内部混进了 Markdown 控制符/正文/换行。

const risky = /\\underbrace|\\overbrace|\\stackrel|\\substack|\\begin\{(cases|aligned|array|matrix|pmatrix|bmatrix|dcases)\}|\\displaystyle|\\xrightarrow|\\overset|\\underset|\\substack/;
const ENV = /\\begin\{([a-zA-Z*]+)\}/g;
// 数学块内部不该出现的 Markdown / 结构信号
const POLLUTION = /(^|\n)\s{0,3}#{1,6}\s|(^|\n)\s*[-*+]\s|(^|\n)\s*\d+\.\s|\*\*|((^|\n)\s*>\s)|\n\n/;
const CJK = /[\u4e00-\u9fff]/;

function stripFences(md) {
  return md.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
}

function collectMath(md) {
  const src = stripFences(md);
  const out = [];
  const displayRe = /\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g;
  let m;
  while ((m = displayRe.exec(src))) {
    out.push({ start: m.index, body: m[1] !== undefined ? m[1] : m[2], display: true });
  }
  const inlineRe = /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)|\\\(([\s\S]*?)\\\)/g;
  while ((m = inlineRe.exec(src))) {
    out.push({ start: m.index, body: m[1] !== undefined ? m[1] : m[2], display: false });
  }
  return out;
}

/** 边界污染：块内混入了不该属于公式的内容 */
function pollution(body) {
  const reasons = [];
  const cjk = CJK.test(body);
  if (cjk) reasons.push("含中文正文");
  if (POLLUTION.test(body)) reasons.push("含 Markdown 控制符/空行");
  if (body.length > 80 && cjk && /[，。；：、]/.test(body)) reasons.push("正文被吞进公式");
  return reasons;
}

/** 公式复杂度（不含 \big/\left 这类零成本修饰） */
function complexity(body) {
  const reasons = [];
  let score = 0;
  const len = body.length;
  if (len > 160) { score += (len - 160) / 50; reasons.push(`len=${len}`); }

  let maxBrace = 0;
  for (let i = 0, d = 0; i < body.length; i++) {
    if (body[i] === "{") { d++; if (d > maxBrace) maxBrace = d; }
    else if (body[i] === "}") d--;
  }
  if (maxBrace >= 2) { score += (maxBrace - 1) * 1.2; reasons.push(`braceDepth=${maxBrace}`); }

  const hits = body.match(new RegExp(risky.source, "g"));
  if (hits) { score += hits.length * 0.7; reasons.push(`heavy=${hits.length}(${[...new Set(hits)].slice(0, 3).join(",")})`); }

  const envs = body.match(ENV);
  if (envs && envs.length > 1) { score += envs.length * 0.4; reasons.push(`env=${envs.length}`); }
  if (body.includes("\n")) score += 0.2;

  return { score: Math.round(score * 10) / 10, reasons };
}

function analyze(markdown) {
  const blocks = collectMath(markdown).map((b) => {
    const poll = b.display ? pollution(b.body) : pollution(b.body).filter((r) => r !== "含 Markdown 控制符/空行");
    const cplx = complexity(b.body);
    return { ...b, pollution: poll, ...cplx };
  });

  const polluted = blocks.filter((b) => b.pollution.length > 0);
  let density = 0;
  for (let i = 0; i < blocks.length; i++) {
    let n = 1;
    for (let j = i + 1; j < blocks.length && blocks[j].start - blocks[i].start < 200; j++) n++;
    if (n > density) density = n;
  }
  const total = Math.round(blocks.reduce((a, b) => a + b.score, 0) * 10) / 10;
  const worst = blocks.reduce((a, b) => Math.max(a, b.score), 0);

  // 判定：边界污染 -> 源码模式；公式过重/过密 -> 懒渲染；否则正常 KaTeX
  const verdict =
    polluted.length > 0 ? "SOURCE(源码模式)" :
    worst >= 5 || total >= 25 || density >= 8 ? "LAZY(懒渲染)" : "KATEX(直接渲染)";

  return { count: blocks.length, total, worst, density, polluted: polluted.length, verdict, blocks };
}

const SAMPLE_BAD = String.raw`=\underbrace{\tfrac12\varphi(x-t)}_{\text{右行波 }F}+\underbrace{\tfrac12\varphi(x+t)}_{\text{左行波 }G}$ 初始鼓包被劈成两半，每半高度 $1/2$ ## 第 2 步：写出反射规则 固定端 $u(0,t)=0\Rightarrow$ 对初值作**奇延拓** $\tilde\varphi(\xi)=-\varphi(-\xi)$，于是
$$u(x,t)=\frac{\tilde\varphi(x-t)+\varphi(x+t)}{2}=\begin{cases} \tfrac12\big[\varphi(x-t)+\varphi(x+t)\big], & x\ge t\\[8pt] \tfrac12\big[-\varphi(t-x)+\varphi(x+t)\big], & x<t \end{cases}$$ 每点的算法只有两步：查 $x-t$、$x+t$ 两处的初值；
**$t=1.5$（反射波已返回，$x-t=-0.5<0$，需反射）**：$u=\tfrac12[-\varphi(0.5)+\varphi(2.5)]=\tfrac12[-e^{-2.25}+e^{-0.25}]=\tfrac12[-0.105399+0.778801]=0.336701$$`;

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

const MONSTER = "$$" + Array.from({ length: 40 }, (_, i) => `\\underbrace{\\frac{a_{${i}}}{b_{${i}}}}_{\\text{term }${i}}`).join("+") + "$$";
const DENSE_OK = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 步：$u_{${i}}=e^{-${i}}$。`).join("\n\n");

for (const [label, text] of [
  ["A 原稿（翻车排版）", SAMPLE_BAD],
  ["B 重排后（同样数学）", SAMPLE_GOOD],
  ["C 合成超大公式（40 项 underbrace）", MONSTER],
  ["D 公式很密但都合法（12 个小公式）", DENSE_OK],
]) {
  const r = analyze(text);
  console.log(`\n=== ${label} ===`);
  console.log(`块 ${r.count} | 总复杂度 ${r.total} | 最坏 ${r.worst} | 密度 ${r.density}/屏 | 污染块 ${r.polluted} -> ${r.verdict}`);
  r.blocks
    .slice()
    .sort((a, b) => (b.pollution.length - a.pollution.length) || (b.score - a.score))
    .slice(0, 3)
    .forEach((s) => {
      const tag = s.pollution.length ? `污染:${s.pollution.join("/")}` : `复杂:${s.reasons.join(" ") || "-"}`;
      console.log(`   ${s.display ? "[行间]" : "[行内]"} ${tag} :: ${s.body.slice(0, 40).replace(/\n/g, "⏎")}…`);
    });
}
