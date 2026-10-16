import { readFileSync } from 'node:fs'
import { loadKatex } from './katex.mjs'

const { findMathRegions, inspect, repairText, judge, rendersRed, echoedErrorText, errorEcho, recoverRedRegion, ERROR_COLOR, loadOracle } = await import('../lib/tex-repair.js')

// The renderer must be loaded before any verdict is asked for; `judge` reports "oracle
// unavailable" rather than guessing, so a forgotten wait here shows up as an obvious
// failure instead of a silent pass. This is the RAW renderer, loaded independently of the
// oracle, so the two accounts can be compared instead of one being trusted.
const oracle = await loadOracle()
const { katex } = await loadKatex()
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** Render with the product's own chain and report whether any error colour appears. */
function renders(tex, displayMode) {
  let html = null
  try {
    html = katex.renderToString(tex, { displayMode, throwOnError: true })
  } catch {
    try {
      html = katex.renderToString(tex, { displayMode, strict: 'ignore', throwOnError: false })
    } catch {
      return { html: null, red: false, threw: true }
    }
  }
  return { html, red: rendersRed(html), threw: false }
}

console.log('=== 1. the two silent-red classes are detected ===')

const cases = [
  { label: 'unknown command', tex: '\\foobar{x}', display: true, expectReason: 'oracle-rejected' },
  { label: 'unknown command, no args', tex: 'x = \\notacommand', display: true, expectReason: 'oracle-rejected' },
  { label: 'trust-gated command (strict passes, output is red)', tex: '\\htmlClass{red}{x}', display: true, expectReason: 'red-render' },
  { label: 'unknown command inside cases', tex: '\\begin{cases} \\bad & x \\ge t \\\\ b & x < t \\end{cases}', display: true, expectReason: 'oracle-rejected' },
  { label: 'unclosed brace', tex: '\\frac{1}{2', display: true, expectReason: 'oracle-rejected' },
  { label: 'double subscript', tex: 'x_1_2', display: true, expectReason: 'oracle-rejected' },
]

for (const c of cases) {
  const region = { kind: c.display ? 'display' : 'inline', body: c.tex, raw: `$$${c.tex}$$`, delimiter: '$$', unterminated: false, midLineDisplay: false }
  const verdict = inspect(region)
  check(`${c.label}: detected`, verdict.verdict === 'repair', `got ${verdict.verdict}`)
  if (c.expectReason) check(`${c.label}: reason is ${c.expectReason}`, verdict.reason === c.expectReason, `got ${verdict.reason}`)
}

console.log('\n=== 2. the strict pass alone would MISS these ===')
for (const tex of ['\\htmlClass{red}{x}', '\\includegraphics{a.png}']) {
  const v = judge(tex, true)
  check(`${JSON.stringify(tex)}: strict succeeds yet renders red`, v.ok === true && v.red === true, `ok=${v.ok} red=${v.red}`)
}

console.log('\n=== 3. recovery keeps the content visible ===')
const recoverable = [
  ['\\foobar{x}', 'foobar{x}'],
  ['x = \\notacommand', 'x = notacommand'],
  // A doubled subscript is recoverable — the renderer echoes exactly which part to group —
  // but its echo lives in the MESSAGE, not in an <mtext> annotation, so the html-only
  // reader saw null and this case fell through to the fence. Reported from a real answer,
  // where the fence then cut a table row in half.
  ['x_1_2', 'x_{1_2}'],
  ['a_b_c', 'a_{b_c}'],
  // Reported from a real session: more than one doubled subscript in a single region. The
  // renderer reports one of them at a time, so a repair that regroups only one candidate is
  // rejected by its own re-judge (`a_{1_2} + b_3_4` is still red), and the old single-anchor
  // candidate list made the whole region degrade to a fenced block — in a table row, that
  // fence then cut the row in half. Every doubled subscript in the region is regrouped in the
  // same rewrite.
  ['a_1_2 + b_3_4 = c', 'a_{1_2} + b_{3_4} = c'],
  ['\\begin{cases} \\bad & x \\ge t \\\\ b & x < t \\end{cases}', null],
  ['\\htmlClass{red}{x}', null],
]
for (const [tex, expect] of recoverable) {
  const r = recoverRedRegion(tex, true)
  check(`recovered: ${JSON.stringify(tex.slice(0, 40))}`, r.ok, `moves=${JSON.stringify(r.moves)}`)
  if (r.ok) {
    const rendered = renders(r.body, true)
    check(`  the repaired TeX renders clean`, !rendered.red && !rendered.threw, `red=${rendered.red} threw=${rendered.threw}`)
    check(`  the reader can still see the command name`, r.moves.length > 0, `moves=${JSON.stringify(r.moves)}`)
    if (expect) check(`  substitution is the expected one`, r.body === expect, `got ${JSON.stringify(r.body)}`)
  }
}

console.log('\n=== 3b. the echo is read from whichever account carries it ===')
const subscriptVerdict = judge('x_1_2', false)
check(
  'the message account names the offending source',
  echoedErrorText(subscriptVerdict.html, subscriptVerdict.message) === 'x_1_2',
  `got ${JSON.stringify(echoedErrorText(subscriptVerdict.html, subscriptVerdict.message))}`,
)
check(
  'the html account alone still cannot (this is the shape that used to be trusted)',
  echoedErrorText(subscriptVerdict.html) === null,
  `html-only read gave ${JSON.stringify(echoedErrorText(subscriptVerdict.html))}`,
)
const commandVerdict = judge('\\foobar{x}', false)
check(
  'for an unknown command both accounts agree',
  echoedErrorText(commandVerdict.html, commandVerdict.message) === '\\foobar' && echoedErrorText(commandVerdict.html) === '\\foobar',
  `html=${JSON.stringify(echoedErrorText(commandVerdict.html))} both=${JSON.stringify(echoedErrorText(commandVerdict.html, commandVerdict.message))}`,
)
// A red render reports NO message at all: the strict pass succeeded and KaTeX painted the
// source red. The echo has to come from the painted span, or the region can only be fenced —
// and `errorEcho` refusing the whole region is what put a fence inside a table row.
const redVerdict = judge('\\htmlClass{red}{x}', true)
check(
  'a red render carries no message, so the painted span is the echo',
  redVerdict.message === null && errorEcho(redVerdict.html, redVerdict.message, '\\htmlClass{red}{x}')?.echo === '\\htmlClass',
  `message=${JSON.stringify(redVerdict.message)} echo=${JSON.stringify(errorEcho(redVerdict.html, redVerdict.message, '\\htmlClass{red}{x}'))}`,
)

console.log('\n=== 4. unrecoverable damage is fenced, never guessed ===')
// `x_1_2` used to sit in this list. It was here because the guard could not recover it,
// and a test that asserts the current behaviour of a gap keeps the gap: grouping the
// subscript is the author's own mathematics (`x_1_2` and `x_{1_2}` render the same thing),
// so the recoverable list is where it belongs. What stays here is damage the echo cannot
// drive a repair for, with the nested doubled subscript as the control: `x_1_2_3` fixes one
// level and then stops, so it must degrade visibly rather than be guessed at twice.
const unfixable = ['\\frac{1}{2', 'x_1_2_3', 'x_{1_2}_3', '\\begin{cases} a & b \\\\ c']
for (const tex of unfixable) {
  const r = recoverRedRegion(tex, true)
  const out = repairText(`正文 $${tex}$ 结束`)
  check(`${JSON.stringify(tex)}: not reported as repaired`, !r.ok || renders(r.body, true).red === false)
  const dumped = renderAll(out.text)
  check(`${JSON.stringify(tex)}: the emitted text has no red`, dumped.red === 0, `${dumped.red} red span(s)`)
  // The source has to reach the reader. For a display region that means the fenced block;
  // for an INLINE one the delimiters are removed and the source stands as plain text, which
  // is what keeps a table row on one line. Either way the formula is still readable.
  check(
    `${JSON.stringify(tex)}: the original source survives in the output`,
    out.text.includes(tex.trim()),
    `source lost from ${JSON.stringify(out.text)}`,
  )
}
// `x_{1_2}_3` is the control for the grouping rule: the subscript inside the braces is valid
// TeX and the renderer complains about the OUTER one, so a repair that regroups from the last
// `_` in the token rewrites the author's own `x_{1_2}` into `x_{1_{2_3}}`. It renders, but it
// says something else, so the region must degrade visibly instead.
check(
  'a subscript already inside a group is left alone, even when the region is repaired',
  repairText('正文 $x_{1_2}_3$ 结束').text.includes('x_{1_2}'),
  `got ${JSON.stringify(repairText('正文 $x_{1_2}_3$ 结束').text)}`,
)

console.log('\n=== 5. healthy regions must not be touched ===')
const healthies = [
  '\\frac{1}{2}',
  '\\text{恒等式}',
  '\\underbrace{\\underbrace{a}_{1}}_{2}',
  'E = mc^2',
  '\\begin{cases} a & x \\ge t \\\\ b & x < t \\end{cases}',
  '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
]
for (const tex of healthies) {
  const out = repairText(`前 $${tex}$ 后`)
  const region = findMathRegions(`前 $${tex}$ 后`)[0]
  const verdict = inspect(region)
  check(`${JSON.stringify(tex.slice(0, 34))}: left alone`, out.repairs.length === 0 && verdict.verdict === 'ok', `verdict=${verdict.verdict} repairs=${out.repairs.length}`)
}

/** Count error-coloured regions in emitted text by rendering each region the guard left. */
function renderAll(text) {
  const regions = findMathRegions(text)
  let red = 0
  for (const r of regions) {
    const display = r.kind === 'display'
    const rendered = renders(r.body, display)
    if (rendered.red) red += 1
  }
  return { red, total: regions.length }
}

console.log('\n=== 6. the real incident text through the guard ===')
const incident = readFileSync(new URL('./fixtures/real-broken.txt', import.meta.url), 'utf8')
const withNasty =
  `${incident}\n\n坏例子：$\\foobar{x}=y$，还有 $\\htmlClass{red}{z}$，以及 $\\frac{1}{2}$ 收尾。\n`
const out = repairText(withNasty)
const before = renderAll(withNasty)
const after = renderAll(out.text)
check('the input had red-rendering regions', before.red > 0, `${before.red}/${before.total} red`)
check('after the guard NO region renders red', after.red === 0, `${after.red}/${after.total} still red`)
check('the guard reported the repairs it made', out.repairs.length >= 2, `${out.repairs.length} repair(s)`)
// The unknown command is repaired, so its backslash is gone by design: the reader now sees
// `foobar` as visible text instead of a red `\foobar`. What must survive is the NAME, which
// is why this asserts on the bare word and on the absence of the red span.
check('the unknown command is shown as visible text instead of red', out.text.includes('foobar') && !/\\foobar\{/.test(out.text), 'the token was dropped rather than shown')
check('the repaired region is framed as maths, not fenced away', out.text.includes('$$\nfoobar') || out.text.includes('foobar{x}'), 'the repaired formula was not re-framed')
console.log(`  ${before.red} red region(s) before -> ${after.red} after, ${out.repairs.length} repair(s)`)
for (const r of out.repairs.slice(0, 6)) console.log(`    [${r.reason}] ${r.detail?.slice(0, 70) ?? ''}`)

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
if (fail > 0) process.exitCode = 1