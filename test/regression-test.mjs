/**
 * Regression tests for defects that reached a real transcript.
 *
 * Every case here is quoted from a stored session, not invented, and every one of them was a
 * live failure of this plugin — which is why they belong in the suite rather than in a bug
 * tracker: the criteria they pin are the ones that were wrong.
 *
 * The property under test is the one the user actually experiences:
 *
 *     whatever the guard emits must render without the error colour, in the framing it lands in
 *
 * "flagged", "repaired" and "fixed" are three different things. A region can be flagged by a
 * structural rule, handed to the repairer, and come back worse than it started; and a region
 * that is never flagged at all is only safe if the renderer agrees. So this file checks the
 * emitted text against the renderer directly, region by region, and does not trust the
 * verdict to imply the outcome.
 *
 * RUN: node test/regression-test.mjs
 */

import { findMathRegions, inspect, judge, repairText, loadOracle } from '../lib/tex-repair.js'
import { createBlockState, BUILD } from '../lib/guard.js'

const oracle = await loadOracle()
if (!oracle.available) {
  // Without the renderer this file would pass vacuously, which is the failure mode it exists
  // to prevent. Refuse to run rather than report a false green.
  console.error(`oracle unavailable (${oracle.error}) — this file cannot judge anything without it`)
  process.exit(1)
}

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    failures.push(`${name} — ${detail}`)
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

/**
 * Faults in the text the renderer would actually paint red, judged as display and as inline —
 * whichever framing the renderer ends up choosing, it must not reject the maths.
 */
function redRegions(text) {
  return findMathRegions(text).filter((r) => {
    const display = r.kind === 'display'
    const v = judge(r.body, display)
    return !v.ok || v.red
  })
}

/** Run text through the guard exactly as a stream does, one delta at a time. */
function throughGuard(text, size = 7) {
  const state = createBlockState()
  let out = ''
  for (let i = 0; i < text.length; i += size) out += state.push(text.slice(i, i + size))
  return out + state.finish()
}

console.log(`regression tests — BUILD=${BUILD}, katex ${oracle.version}\n`)

// ---------------------------------------------------------------------------------------
console.log('=== 1. a renderer-valid region must not be flagged or touched ===')
// The pairing heuristic opens a region at the `$` inside `\text{…}`, so the text looks like
// damage: the first region ends at that `$` and the remainder appears to open another region.
// KaTeX renders it fine. Treating the pattern as a verdict made the guard re-frame the region,
// which split the text so a NEW region opened around the second `$` and ran on — the "repair"
// left the document worse than it found it, in a live transcript.
{
  const real =
    '所以 $u_{tt}=c^2u_{xx}$ 等价于\n\n' +
    '$$d\\alpha=0\\qquad(\\text{$\\alpha$ 是闭 1-形式}).$$\n\n' +
    '对平行四边形区域 $\\square ABCD$ 用 Stokes 定理。'
  const stripped = '$$d\\alpha=0\\qquad(\\text{$\\alpha$ 是闭 1-形式}).$$'

  const region = findMathRegions(stripped)[0]
  check('the region is recognised as display maths', Boolean(region) && region.kind === 'display', `got ${region?.kind}`)
  const verdict = inspect(region)
  check(
    'it is NOT flagged for repair',
    verdict.verdict === 'ok',
    `verdict=${verdict.verdict} reason=${verdict.reason} detail=${verdict.detail}`,
  )
  const { text: out, repairs } = repairText(real)
  check('the repairer changes nothing', out === real && repairs.length === 0, `${repairs.length} repair(s): ${repairs.map((r) => r.reason).join(', ')}`)
  check('and nothing in it renders red', redRegions(out).length === 0, JSON.stringify(redRegions(out).map((r) => r.body.slice(0, 40))))
}

// ---------------------------------------------------------------------------------------
console.log('\n=== 2. the math itself renders as-is, so it needs no re-framing ===')
// Same class, different symptom: a continuation line that starts with `+` looks like a Markdown
// list item (`list-inside`), and re-framing it would have been unnecessary — the body renders
// strictly as display maths exactly as written.
{
  const real =
    '由达朗贝尔公式（初值问题）：若 $u(x,0)=\\varphi(x)$，$u_t(x,0)=\\psi(x)$，则\n\n' +
    '$$\n' +
    'u(x,t) = \\frac{\\varphi(x-ct)+\\varphi(x+ct)}{2}\n' +
    '+ \\frac{1}{2c}\\int_{x-ct}^{x+ct}\\psi(s)\\,ds .\n' +
    '$$\n\n' +
    '解读：初始位移一分为二、各走一边。'
  const { text: out, repairs } = repairText(real)
  check('no repair is attempted', repairs.length === 0, `${repairs.length}: ${repairs.map((r) => r.reason).join(', ')}`)
  check('the text is byte-identical', out === real)
  check('no region of it renders red', redRegions(out).length === 0)
  check('the formula survives verbatim', out.includes('+ \\frac{1}{2c}\\int_{x-ct}^{x+ct}\\psi(s)\\,ds .'))
}

// ---------------------------------------------------------------------------------------
console.log('\n=== 3. the emitted text, not the verdict, must be clean ===')
// The invariant that would have caught the live defect regardless of which rule was wrong:
// judge what comes OUT. Both of these are real answers that contain flagged regions, and both
// must come out of the stream renderable — as a whole, chunked, and in either framing.
{
  const real = [
    '$$d\\alpha=0\\qquad(\\text{$\\alpha$ 是闭 1-形式}).$$',
    '$$\nu(x,t) = \\frac{\\varphi(x-ct)+\\varphi(x+ct)}{2}\n+ \\frac{1}{2c}\\int_{x-ct}^{x+ct}\\psi(s)\\,ds .\n$$',
    // Genuinely broken, so the property is tested on a document that also needs work.
    '$$S_n=\\frac{n(a_1+a_n)}_{\\text{通项}',
  ].join('\n\n')

  const emitted = throughGuard(real, 5)
  const red = redRegions(emitted)
  check('no region of the emitted text renders red', red.length === 0, `${red.length}: ${JSON.stringify(red.map((r) => r.body.slice(0, 50)))}`)
  check('every formula is still present in some form', ['d\\alpha=0', '\\varphi(x-ct)', 'a_1+a_n'].every((f) => emitted.includes(f)), 'a formula was dropped')

  // The same, but judged in the framing the renderer might choose: a valid body must not
  // depend on the delimiter pair being tokenised as display.
  const inlineRisk = findMathRegions(emitted).filter((r) => judge(r.body, false).red)
  check('nothing renders red even if a region is tokenised as inline', inlineRisk.length === 0, `${inlineRisk.length} region(s)`)
}

// ---------------------------------------------------------------------------------------
console.log('\n=== 4. the fix did not disarm the real detection ===')
// A rule that never fires is also a bug. These are the faults the plugin exists for, and each
// must still be flagged AND must come out clean.
{
  const broken = [
    ['glued heading', '$$\nx=1\n## 第 2 步：代入\n$$'],
    ['mid-paragraph display', '于是 $$u=\\varphi(1)+\\varphi(1)$$ 得到 $0.5$。'],
    ['unknown command', '于是 $\\foobar{x}=y$ 收尾。'],
    ['doubled subscript', '设 $x_1_2$ 表示坐标。'],
    ['unclosed brace', '$$\\frac{1}{2\n$$'],
    ['no closing delimiter', '计算 $E=mc^2 到这里结束。'],
  ]
  for (const [name, text] of broken) {
    const flagged = findMathRegions(text).filter((r) => inspect(r).verdict !== 'ok')
    check(`${name}: still flagged`, flagged.length > 0, 'nothing flagged — the rule stopped firing')
    const out = throughGuard(text, 3)
    const red = redRegions(out)
    check(`${name}: emitted text is clean`, red.length === 0, `${red.length} region(s) still red`)
  }
}

console.log(`\n=== REGRESSION RESULT: ${pass} passed, ${fail} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}
