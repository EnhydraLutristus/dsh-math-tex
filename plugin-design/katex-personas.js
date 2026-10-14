// katex-personas.js — 确证两种"人格"+ 量化爆炸阈值
const katex = require("C:\\Users\\<user>\\.dsh\\profiles\\desktop\\node_modules\\katex");

const BAD = String.raw`\underbrace{\tfrac12\varphi(x-t)}_{\text{右行波 }F} ## 第 2 步：写出反射规则`;

console.log("### A. throwOnError:true（KaTeX 默认）在真实失败输入上的行为");
try {
  katex.renderToString(BAD, { throwOnError: true });
  console.log("   未抛错（意外）");
} catch (e) {
  console.log(`   ✗ 抛出 ${e.name}`);
  console.log(`     message  : ${String(e.message).split("\n")[0]}`);
  console.log(`     position : ${e.position}  (输入长 ${BAD.length})`);
  console.log(`     rawMessage存在: ${"rawMessage" in e}`);
  console.log("   → 若宿主用默认配置且没有 ErrorBoundary，这个异常会沿 React 渲染链上抛：");
  console.log("     轻则该条消息白屏，重则整棵消息列表卸载 —— 这才是真正的\"渲染器崩溃\"路径。");
}

console.log("\n### B. throwOnError:false 时，红色错误块到底把什么当作内容显示");
const out = katex.renderToString(BAD, { throwOnError: false });
const m = out.match(/title="([^"]*)"/);
console.log("   title 属性（= 用户悬浮可见的原文）:");
console.log("     " + (m ? m[1] : "(无)").slice(0, 220));
// 错误块的可见文本（去掉标签后的纯文本）
const text = out.replace(/<[^>]*>/g, "");
console.log(`   可见文本 = 原始输入的前 ${text.length} 字符，逐字照抄：`);
console.log("     " + text.slice(0, 160) + (text.length > 160 ? " …" : ""));
console.log(`   → 用户看到的\"红色 LaTeX 源码\"就是指这段：解析在 position=${"?"} 处中止后，`);
console.log("     KaTeX 把 raw source 原样放进 <span class=\"katex-error\" style=\"color:#cc0000\">。");
console.log("     所以现象不是崩溃，是**优雅降级成红字**——而 if 模型把整段推导塞进一个 $$，红字就是整段。");

console.log("\n### C. 布局爆炸阈值（maxSize 默认 Infinity，DOM 规模不受限）");
for (const n of [50, 200, 500, 1000, 2000]) {
  const tex = String.raw`\begin{array}{` + "c".repeat(n) + "}" + "x&".repeat(n - 1) + "x" + String.raw`\end{array}`;
  const t0 = process.hrtime.bigint();
  let html = "";
  try { html = katex.renderToString(tex, { throwOnError: false }); } catch { }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const domNodes = (html.match(/<span/g) || []).length;
  console.log(`   ${String(n).padStart(4)} 列 → HTML ${String(html.length).padStart(9)} 字符, <span> ${String(domNodes).padStart(7)} 个, ${ms.toFixed(0).padStart(6)} ms`);
}

console.log("\n### D. 密集嵌套 \\frac / \\sqrt / 上下标（模型最爱写的\"复杂\"式子）");
for (const depth of [5, 8, 10, 12, 14, 16]) {
  let tex = "x";
  for (let i = 0; i < depth; i++) tex = String.raw`\frac{` + tex + `}{` + tex + `}`;
  const t0 = process.hrtime.bigint();
  let html = "", oom = "";
  try { html = katex.renderToString(tex, { throwOnError: false }); }
  catch (e) { oom = ` ← 抛 ${e.name}: ${e.message.slice(0, 40)}`; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const ratio = html.length ? (html.length / tex.length).toFixed(1) + "x" : "-";
  console.log(`   \\frac 递归深度 ${String(depth).padStart(2)} → 输入 ${String(tex.length).padStart(8)} 字符 → HTML ${String(html.length).padStart(9)} 字符 (放大 ${ratio}), ${ms.toFixed(0).padStart(6)} ms${oom}`);
}
let sub = "x";
for (let i = 0; i < 30; i++) sub = sub + "_" + i;
const t0 = process.hrtime.bigint();
const sh = katex.renderToString(sub, { throwOnError: false });
console.log(`   30 层下标链 → HTML ${sh.length} 字符, ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)} ms`);

console.log("\n### E. 诊断规则验证：\\text{中文} 单独渲染 OK，一旦与 $$ 混排就整块变红");
const frags = {
  "纯中文 text（无 $$ 混排）": String.raw`\text{右行波 }F`,
  "## 在数学模式内": String.raw`a ## b`,
  "Markdown 加粗在数学模式内": String.raw`a **b** c`,
  "中文裸写在数学模式内": String.raw`u=\frac12\varphi(x-t) 右行波`,
  "\\text{中文} + \\; 全角标点": String.raw`\text{右行波}，\text{左行波}`,
};
for (const [label, tex] of Object.entries(frags)) {
  let verdict, detail = "";
  try {
    const h = katex.renderToString(tex, { throwOnError: false });
    verdict = /katex-error/.test(h) ? "▲ 红块" : "✓ 正常";
    const mm = h.match(/title="([^"]*)"/);
    if (mm) detail = " — " + mm[1].slice(0, 90);
  } catch (e) { verdict = "✗ 抛异常"; detail = " — " + e.message.split("\n")[0].slice(0, 90); }
  console.log(`   ${verdict.padEnd(8)} ${label}${detail}`);
}
