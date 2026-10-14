import { readFileSync } from 'node:fs'
import { repairText, findMathRegions, inspect, judge, inspectText, loadOracle } from '../lib/tex-repair.js'

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
console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  - ${f}`)
}
process.exitCode = fail === 0 ? 0 : 1
void judge