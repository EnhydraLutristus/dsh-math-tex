import { readFileSync } from 'node:fs'
import { repairText, findMathRegions, inspect, judge, inspectText, loadOracle } from '../lib/tex-repair.js'
import { createBlockState, guardStream } from '../lib/guard.js'

/**
 * Feed `text` through the real streaming path and collect every log line.
 *
 * `via` picks the public entry point: `state` is what runs inside one text block,
 * `stream` is the iterable wrapper the plugin actually hooks. Both must behave.
 *
 * The delta size matters: the defect being watched for only becomes visible once
 * enough of the region has arrived, so it is re-examined on every later delta. A
 * single-chunk feed would hide that entirely.
 */
async function streamThrough(text, via = 'state', size = 5) {
  const lines = []
  if (via === 'state') {
    // `createBlockState` takes its sink as `log`; `guardStream` takes it as `onLog`.
    // Asking for the wrong name is silent: the sink falls back to the module default and
    // every line vanishes, which is how a green test can end up watching nothing at all.
    const state = createBlockState({ log: (line) => lines.push(line), repairMode: 'auto' })
    for (let i = 0; i < text.length; i += size) state.push(text.slice(i, i + size))
    state.finish()
    return lines
  }
  const inner = (async function* () {
    for (let i = 0; i < text.length; i += size) yield { type: 'text-delta', index: 0, text: text.slice(i, i + size) }
  })()
  for await (const chunk of guardStream(inner, { onLog: (line) => lines.push(line), repairMode: 'auto' })) void chunk
  return lines
}

const oracle = await loadOracle()
console.log(`oracle: available=${oracle.available} version=${oracle.version}\n`)
let pass = 0
let fail = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    failures.push(`${name} — ${detail}`)
    console.log(`  FAIL  ${name}\n        ${detail}`)
  }
}

// ---------------------------------------------------------------------------
console.log('=== A. clean text must NOT be touched ===\n')
const cleanCases = [
  ['inline maths', '设 $u_t(x,0)=0$ 时公式只剩第一项。'],
  ['display maths on its own paragraph', '推导如下：\n\n$$\n\\frac{\\partial u}{\\partial t}=c^2\\frac{\\partial^2 u}{\\partial x^2}\n$$\n\n继续。'],
  ['display maths with CJK inside \\text{}', '$$\n\\underbrace{\\sin^2\\theta+\\cos^2\\theta}_{\\text{恒等式 }I}\n$$'],
  ['long legal formula', `$$\\sum_{i=1}^{n}\\frac{\\partial u_i}{\\partial t} + \\sum_{j=1}^{m}\\frac{\\partial^2 u_j}{\\partial x^2} = \\int_0^T f(s)\\,ds + \\underbrace{g(x)}_{\\text{source host}} + \\Theta(1)$$`],
  ['cases environment', '$$\nf(x)=\\begin{cases} x^2, & x\\ge 0\\\\ -x^2, & x<0\\end{cases}\n$$'],
  ['money in prose (not maths)', '价格是 $5 到 $6 之间，另外 $x$ 是变量。'],
  ['no maths at all', '这段中文完全没有公式，也没有美元符号。'],
  ['escaped dollar', '成本 \\$100 与 \\$200。'],
]
for (const [name, text] of cleanCases) {
  const { text: out, repairs } = repairText(text)
  const untouched = out === text
  check(
    name,
    untouched,
    untouched ? '' : `${repairs.length} repair(s) applied to clean text: ${repairs.map((r) => `${r.reason} on ${JSON.stringify(r.before.slice(0, 40))}`).join('; ')}`,
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== B. broken text must be caught, without losing the formula ===\n')
const brokenCases = [
  [
    'glued heading inside the display block',
    '$$\nx=\\underbrace{\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}}_{\\text{求根公式 }R}\n## 第 2 步：代入系数\n$$',
    '第 2 步',
  ],
  [
    '$$ opened mid-paragraph (pairs one off)',
    '公式如下：$$S_n=\\frac{n(a_1+a_n)}{2}$$ 这是等差数列的求和公式。',
    '\\frac{n(a_1+a_n)}{2}',
  ],
  [
    'unclosed brace',
    '$$\nu=\\frac{1}{2\n$$',
    '\\frac{1}{2',
  ],
  [
    'double subscript',
    '设 $x_1_2$ 表示坐标。',
    'x_1_2',
  ],
  [
    'stray $ inside a display block',
    '$$\nu = x $ y\n$$',
    'y',
  ],
  [
    'unterminated inline maths',
    '计算 $E=mc^2 到这里结束。',
    'E=mc^2',
  ],
  [
    '\\begin without \\end',
    '$$\n\\begin{cases} a & x\\ge 0\n$$',
    '\\begin{cases}',
  ],
]
for (const [name, text, mustSurvive] of brokenCases) {
  const { text: out, repairs } = repairText(text)
  const caught = repairs.length > 0
  check(name, caught, 'no repair was applied — this input would still render as it did')

  if (!caught) continue

  // the formula source must still be present in the repaired output
  const body = mustSurvive.replace(/^\\/, '\\\\')
  const survived = out.includes(mustSurvive)
  check(`${name} — formula source preserved`, survived, `"${mustSurvive}" is gone from the repaired text`)

  // and nothing in the repaired text may still be rejected
  const stillBad = findMathRegions(out).filter((r) => inspect(r).verdict !== 'ok')
  check(`${name} — output is clean`, stillBad.length === 0, `${stillBad.length} region(s) still rejected: ${stillBad.map((r) => inspect(r).reason).join(', ')}`)
  void body
}

// ---------------------------------------------------------------------------
console.log('\n=== C. the real incident text ===\n')
const real = readFileSync(new URL('./fixtures/real-broken.txt', import.meta.url), 'utf8')
const beforeRegions = findMathRegions(real)
const beforeBad = beforeRegions.filter((r) => inspect(r).verdict !== 'ok')
const { text: repairedReal, repairs: realRepairs } = repairText(real)
const afterBad = findMathRegions(repairedReal).filter((r) => inspect(r).verdict !== 'ok')

console.log(`  regions before: ${beforeRegions.length}, rejected: ${beforeBad.length}`)
console.log(`  repairs applied: ${realRepairs.length}`)
for (const r of realRepairs.slice(0, 4)) console.log(`    - ${r.kind}: ${r.reason} — ${String(r.detail).slice(0, 100)}`)
if (realRepairs.length > 4) console.log(`    … and ${realRepairs.length - 4} more`)
console.log(`  regions after: ${findMathRegions(repairedReal).length}, rejected: ${afterBad.length}`)

check('the real incident text is detected as broken', beforeBad.length > 0, 'zero defects found in text the user saw fail')
check('the repaired text has no rejected regions', afterBad.length === 0, `${afterBad.length} still rejected`)
check(
  'the mathematics survives the repair',
  repairedReal.includes('\\begin{cases}') &&
    repairedReal.includes('\\frac{0.04}{4}') &&
    repairedReal.includes('1.2196'),
  'a formula fragment is missing from the repaired text',
)

// ---------------------------------------------------------------------------
console.log('\n=== D. robustness — the guard must never throw into a stream ===\n')
const nasty = [
  ['empty', ''],
  ['single dollar', '$'],
  ['only delimiters', '$$$$'],
  ['triple dollar', '$$$x$$$'],
  ['huge input', '$x$ '.repeat(4000)],
  ['null-ish', undefined],
  ['nested dollars in text', '$$a $ b$$ and $c$'],
]
for (const [name, text] of nasty) {
  let threw = null
  let result = null
  try {
    result = repairText(text)
  } catch (err) {
    threw = err
  }
  check(
    `${name}`,
    threw === null && typeof result?.text === 'string',
    threw ? `threw: ${threw.message}` : 'did not return a string',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== E. one defect is announced once, however often it is re-examined ===\n')
// This is the shape that produced 61 identical log lines in a real session: a display
// block that is not a defect yet, becomes one partway through, and is then re-scanned by
// every later delta even though it is still the same defect.
const noisy =
  '先说明一下思路。\n\n' +
  '这里要用到一个公式：\n\n' +
  '$$\n' +
  'R = \\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}\n' +
  '## 第 2 步：代入系数\n' +
  '$$\n\n' +
  '所以结论成立。\n'
// One release is not enough to expose the bug. The live burst happened because the model
// kept writing AFTER the broken region: every closed region releases, every release
// re-repairs the whole text, and the defect from earlier paragraphs is found again each
// time. More paragraphs are more chances to say the same thing twice.
const PROSE_STEPS = 20
let noisyLong = noisy
for (let i = 0; i < PROSE_STEPS; i += 1) noisyLong += `\n第 ${i + 1} 段的正文文字，长度足够触发一次释放。\n`
const noisyRepairs = repairText(noisy).repairs.map((r) => r.reason)
const lines = await streamThrough(noisyLong, 'state')
const repairLines = lines.filter((l) => /repaired/.test(l))
const groups = new Map()
for (const line of repairLines) groups.set(line, (groups.get(line) ?? 0) + 1)
const worst = [...groups.entries()].sort((a, b) => b[1] - a[1])[0]

console.log(`  deltas: ${Math.ceil(noisyLong.length / 5)}, repair log lines: ${repairLines.length}`)
console.log(`  the text needs: ${noisyRepairs.length} repair(s) — ${noisyRepairs.join(', ')}`)
for (const [line, n] of groups) console.log(`    ${n}× ${line}`)

check('the text really is defective', noisyRepairs.length > 0, 'the fixture is not broken, so this proves nothing')
check(
  'the identical line is not repeated per delta',
  (worst?.[1] ?? 0) <= 2,
  `one line was written ${worst?.[1]} times (before the fix: one per delta, 61 in the live session)`,
)
check(
  'no more repair lines than the text has repairs',
  repairLines.length <= noisyRepairs.length + 1,
  `${repairLines.length} line(s) for ${noisyRepairs.length} repair(s)`,
)
check('every defect still gets said out loud', repairLines.length > 0, 'nothing was logged at all')

// A second defect, far enough down the text that it only exists after more releases have
// happened: the log must gain a line for it and still not repeat the first one.
let twoDefects =
  '先说明一下思路。\n\n$$\nR = \\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}\n## 第 2 步：代入系数\n$$\n\n' +
  '这一段的正文文字，长度足够触发一次释放。\n\n$$\nQ = \\frac{1}{2\n$$\n\n' +
  `结论成立。\n${'もう一段落の本文です。'.repeat(3)}\n`
for (let i = 0; i < PROSE_STEPS; i += 1) twoDefects += `\n第 ${i + 1} 段补充说明，同样长到足以触发一次释放。\n`
const twoExpected = repairText(twoDefects).repairs.map((r) => r.reason)
const twoLines = (await streamThrough(twoDefects, 'state')).filter((l) => /repaired/.test(l))
console.log(`  second fixture needs: ${twoExpected.length} repair(s) — ${twoExpected.join(', ')}`)
for (const line of twoLines) console.log(`    ${line}`)
check(
  'a second defect is announced too',
  twoExpected.length === 2 && twoLines.length === 2,
  `${twoLines.length} line(s) for ${twoExpected.length} repair(s): ${JSON.stringify(twoExpected)}`,
)
check(
  'each announcement names something new',
  twoLines.length >= 2 && twoLines[0] !== twoLines[1] && /heading-inside/.test(twoLines[0]) && /oracle-rejected/.test(twoLines[1]),
  `the two lines are not two distinct announcements: ${JSON.stringify(twoLines)}`,
)

const streamLines = await streamThrough(noisy, 'stream')
const streamRepairs = streamLines.filter((l) => /repaired/.test(l))
check(
  'the iterable wrapper behaves the same way',
  streamRepairs.length > 0 && streamRepairs.length <= noisyRepairs.length + 1,
  `${streamRepairs.length} line(s) for ${noisyRepairs.length} repair(s)`,
)

// ---------------------------------------------------------------------------
console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  - ${f}`)
}
process.exitCode = fail === 0 ? 0 : 1
void judge