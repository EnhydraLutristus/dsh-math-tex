// repair-math.js — 第 3 条腿的原理验证：把"流式修复"做成确定性、可单元测试的函数
// 关键点：不猜、不重写语义，只做 3 类**语法层**修复，且每步都用真实 KaTeX 校验。
// 这套函数就是插件 host 半在 llm/stream 上要跑的东西（此处先离线证明它有效）。

const katex = require("C:\\Users\\<user>\\.dsh\\profiles\\desktop\\node_modules\\katex");

const KOPTS = { throwOnError: true, strict: "ignore" }; // 校验用：只要不是 ParseError 就算合法

function renders(tex) {
  try { katex.renderToString(tex, KOPTS); return { ok: true }; }
  catch (e) { return { ok: false, why: String(e.message).split("\n")[0].slice(0, 110) }; }
}

// ---------- 修复 1：剥掉漏进数学模式的 Markdown 记号 ----------
// 实测：'##' 立即 ParseError；'**' 能解析但语义错（会变成两个乘号）。
const MD_LEAK = [
  [/^\s*#{1,6}\s+/gm, ""],        // 行首 ## 标题
  [/\*\*/g, ""],                   // 粗体
  [/^\s*[-*+]\s+/gm, ""],         // 列表项
  [/^\s*>\s?/gm, ""],             // 引用
  [/`([^`]*)`/g, "$1"],           // 行内代码
];
function stripMarkdown(tex) {
  let out = tex, hits = [];
  for (const [re, rep] of MD_LEAK) {
    if (re.test(out)) { hits.push(re.source); out = out.replace(re, rep); }
  }
  return { tex: out, hits };
}

// ---------- 修复 2：把裸 CJK 包进 \text{} ----------
// 实测：裸中文在 math mode 下不是 error，只是 strict warning；
// 但在真机字体链里可能落到缺失字形。包进 \text{} 是 KaTeX 官方支持的做法。
// 危险：不能碰已经在 \text{...} / \mathrm{...} 里的中文，也不能碰 \text 的参数。
function wrapCJK(tex) {
  const textLike = /(\\(?:text|textrm|textit|textbf|mathrm|operatorname|mbox)\s*(?:\[[^\]]*\])?\{)/;
  let out = "", i = 0, depthStack = [], wrapped = 0;
  // 简化但正确的策略：分段扫描，跳过所有 \cmd{...} 的参数区，只改裸露的 CJK 段
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]+/;
  while (i < tex.length) {
    const m = textLike.exec(tex.slice(i));
    const c = CJK.exec(tex.slice(i));
    if (c && (!m || c.index < m.index)) {
      // 裸 CJK 段：向前找到同一"参数层"的边界直接整体包住
      out += "\\text{" + c[0] + "}"; wrapped++;
      i += c.index + c[0].length;
      continue;
    }
    if (m) {
      // 复制整个 \cmd{...}（含配对括号），内部不再处理
      const start = i + m.index, argStart = start + m[0].length - 1;
      let d = 0, j = argStart;
      for (; j < tex.length; j++) {
        if (tex[j] === "{") d++;
        else if (tex[j] === "}") { d--; if (d === 0) { j++; break; } }
      }
      out += tex.slice(i, j); i = j; continue;
    }
    out += tex.slice(i); break;
  }
  return { tex: out, wrapped };
}

// ---------- 修复 3：拆分"一个 $$ 吞掉整段推导" ----------
// 真正的病根：模型把标题/正文写进了 $$ 里。合法做法是把它们移出数学模式。
function disbandMathBlock(inner) {
  // 行首 markdown 标题 → 关闭数学模式、输出标题、重开数学模式
  const parts = inner.split(/\n(?=\s*#{1,6}\s)/);
  if (parts.length > 1) {
    return { pieces: parts.map(p => ({ kind: /^\s*#{1,6}\s/.test(p) ? "prose" : "math", text: p })), mode: "split-at-heading" };
  }
  return { pieces: [{ kind: "math", text: inner }], mode: "single" };
}

// ================= 用截图里的真实坏输入做端到端验证 =================
const REAL = String.raw`\underbrace{\tfrac12\varphi(x-t)}_{\text{右行波 }F}+\underbrace{\tfrac12\varphi(x+t)}_{\text{左行波 }G} ## 第 2 步：写出反射规则 固定端 $u(0,t)=0\Rightarrow$ 对初值作**奇延拓**`;
const REAL2 = String.raw`\varphi(2.5)]=\tfrac12[-e^{-2.25}+e^{-0.25}]=0.336701 ## 第 3 步：算出数值 **t=3**：`;

console.log("=========== 修复前后对照（真实坏输入） ===========");
for (const [label, raw] of [["片段 A（含 ## 标题 + ** 粗体）", REAL], ["片段 B（数值段 + ## + **）", REAL2]]) {
  console.log(`\n--- ${label} ---`);
  const before = renders(raw);
  console.log(`  修复前: ${before.ok ? "✓ 可渲染" : "✗ " + before.why}`);

  const split = disbandMathBlock(raw);
  console.log(`  拆分判定: ${split.mode} → ${split.pieces.length} 段 (${split.pieces.map(p => p.kind).join("+")})`);

  let allOk = true;
  for (const [n, p] of split.pieces.entries()) {
    if (p.kind === "prose") { console.log(`    段${n} [prose 移出数学模式] ${JSON.stringify(p.text.slice(0, 46))}`); continue; }
    const s = stripMarkdown(p.text);
    const w = wrapCJK(s.tex);
    const r = renders(w.tex);
    if (!r.ok) allOk = false;
    console.log(`    段${n} [math] 剥Markdown=${s.hits.length}处 包CJK=${w.wrapped}处 → ${r.ok ? "✓ 可渲染" : "✗ " + r.why}`);
    if (!r.ok || w.wrapped) console.log(`        修复后: ${w.tex.slice(0, 150)}`);
  }
  console.log(`  ⇒ ${allOk ? "全部段落通过 KaTeX 校验 ✅" : "仍有段落失败 ❌"}`);
}

console.log("\n=========== 幂等性与误伤检查（修复不能改变已正确的公式） ===========");
const GOOD = [
  String.raw`u=\tfrac12[\varphi(x-t)+\varphi(x+t)]`,
  String.raw`\text{右行波 }F`,
  String.raw`\begin{cases} a & x\ge t \\ b & x<t \end{cases}`,
  String.raw`\varphi(z)=e^{-z^2}`,
  String.raw`\tilde\varphi(\xi)=-\varphi(-\xi)\ (\xi<0)`,
];
for (const g of GOOD) {
  const s = stripMarkdown(g), w = wrapCJK(s.tex);
  const unchanged = w.tex === g;
  const r = renders(w.tex);
  console.log(`  ${unchanged ? "✓ 未改动" : "⚠ 被改动"}  ${r.ok ? "✓ 可渲染" : "✗ " + r.why}   ${g.slice(0, 54)}`);
  if (!unchanged) console.log(`        变成: ${w.tex.slice(0, 110)}`);
}

console.log("\n=========== 边界：\\text{} 内的中文不能被二次包裹 ===========");
const NEST = [String.raw`\text{右行波 }F`, String.raw`\operatorname{sgn}(x)`, String.raw`\mathrm{d}x\ \text{其中 }x>0`];
for (const t of NEST) {
  const w = wrapCJK(t);
  console.log(`  ${w.tex === t ? "✓ 保持不变" : "⚠ 改动"} (包裹次数=${w.wrapped})  ${t}`);
  if (w.tex !== t) console.log(`        → ${w.tex}`);
}

console.log("\n=========== 关键结论：throwOnError:true 下的\"崩溃\"路径可被内联校验拦住 ===========");
console.log("  插件在流式缓冲阶段就对每个完整数学块跑一次 renders()；");
console.log("  不通过 → 就地剥 Markdown / 包 CJK / 拆块；仍不通过 → 降级为空字符串 + 折叠提示，");
console.log("  绝不把非法 LaTeX 交给前端 KaTeX（那才会抛 ParseError 或在 UI 里变成红块）。");
