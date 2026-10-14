// katex-stress.js — 用本机真实 KaTeX 0.16.47 复现「整段推导变红」的真实机制
// 关键日志：把界面渲染成红色的是 KaTeX 的 errorColor（默认 #cc0000），
// 即 throwOnError:false 下**把错误当作内容渲染**的结果，而不是"渲染器崩溃"。
// 另外 throwOnError 默认是 true —— 若宿主用默认配置，未捕获的 ParseError 会
// 直接打断 React 渲染，这才是"崩溃"路径。两种人格都要测。

const katex = require("C:\\Users\\<user>\\.dsh\\profiles\\desktop\\node_modules\\katex");

// 截图里那段真实内容的两段关键片段
const FRAG_UNDERBRACE = String.raw`\underbrace{\tfrac12\varphi(x-t)}_{\text{右行波 }F}+\underbrace{\tfrac12\varphi(x+t)}_{\text{左行波 }G}`;
const FRAG_ASCII = String.raw`\underbrace{\tfrac12\varphi(x-t)}_{\text{right }F}+\underbrace{\tfrac12\varphi(x+t)}_{\text{left }G}`;
const FRAG_CASES = String.raw`u(x,t)=\frac{\tilde\varphi(x-t)+\varphi(x+t)}{2}=\begin{cases} \tfrac12\big[\varphi(x-t)+\varphi(x+t)\big], & x\ge t\\[8pt] \tfrac12\big[-\varphi(t-x)+\varphi(x+t)\big], & x<t \end{cases}`;

function probe(label, tex, opts = {}) {
  const settings = { throwOnError: false, ...opts };
  const t0 = process.hrtime.bigint();
  let out, err = null;
  try {
    out = katex.renderToString(tex, settings);
  } catch (e) {
    err = e;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  if (err) {
    console.log(`✗ ${label}`);
    console.log(`    throwOnError=${settings.throwOnError} → 抛出 ${err.name}: ${String(err.message).split("\n")[0].slice(0, 130)}`);
    if (err.position !== undefined) console.log(`    错误位置 position=${err.position} / 输入长度 ${tex.length}`);
    return { label, threw: true, ms, name: err.name };
  }
  const isErrSpan = /katex-error/.test(out);
  const colored = /color:#cc0000/.test(out);
  console.log(`${isErrSpan ? "▲" : "✓"} ${label}`);
  console.log(`    输出 ${out.length} 字符, ${ms.toFixed(1)} ms${isErrSpan ? ` — 渲染为**错误块**(katex-error, 红色 ${colored ? "#cc0000" : "?"})` : ""}`);
  return { label, threw: false, isErrSpan, ms, html: out };
}

console.log("KaTeX 版本:", require("C:\\Users\\<user>\\.dsh\\profiles\\desktop\\node_modules\\katex\\package.json").version);
console.log("默认 maxExpand=1000, maxSize=Infinity, throwOnError=true, errorColor=#cc0000\n");

console.log("========== 1. 中文 \\text{} —— 头号嫌疑 ==========");
probe("\\text{右行波 }F（截图原文）", FRAG_UNDERBRACE);
probe("\\text{right }F（同结构纯 ASCII）", FRAG_ASCII);

console.log("\n========== 2. 整块推导（截图里一个 $$ 吞掉全文） ==========");
const WHOLE = FRAG_UNDERBRACE + " ## 第 2 步：写出反射规则 固定端 $u(0,t)=0\\Rightarrow$ " + FRAG_CASES;
probe("整块含中文+正文+## 标题", WHOLE);
const r = probe("整块（ASCII 化 \\text）", WHOLE.replace(/右行波|左行波|第 2 步：写出反射规则 固定端/g, "X"));
// 若渲染失败，看看错误块的 HTML 有多长 —— 这决定了用户屏幕上"红块"的大小
if (r.html) {
  const firstErr = r.html.indexOf("katex-error");
  console.log(`    错误块起点=${firstErr}，首个错误块片段: ${r.html.slice(firstErr, firstErr + 200).replace(/\n/g, " ")}`);
}

console.log("\n========== 3. throwOnError:true（KaTeX 默认人格）会怎样 ==========");
probe("同一条 \\text{右行波}", FRAG_UNDERBRACE, { throwOnError: true });

console.log("\n========== 4. 布局爆炸（maxSize 默认 Infinity，拦不住） ==========");
probe("5000 列 array", String.raw`\begin{array}{` + "c".repeat(5000) + "}" + "x&".repeat(4999) + "x" + String.raw`\end{array}`);
probe("\\rule{500em}{500em}", String.raw`\rule{500em}{500em}`);

console.log("\n========== 5. 宏展开炸弹（maxExpand 默认 1000 应拦住） ==========");
const bomb = String.raw`\def\a{\b\b}\def\b{\c\c}\def\c{\d\d}\def\d{\e\e}\def\e{\f\f}\def\f{g}\a`;
probe("6 层 ×2 展开 (=64 次)", bomb);

console.log("\n========== 6. 语法错误（未闭合 / 乱序） ==========");
for (const [l, tex] of [
  ["未闭合花括号", String.raw`\frac{x}{y`],
  ["未闭合 cases", String.raw`\begin{cases} a & b`],
  ["\\right 无 \\left", String.raw`\right)`],
  ["未知命令", String.raw`\foobar{x}`],
  ["双下标", String.raw`x_1_2`],
]) probe(l, tex);
