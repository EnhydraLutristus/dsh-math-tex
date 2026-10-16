import { readFileSync } from 'node:fs'
import { repairText, findMathRegions, inspect, judge, inspectText, loadOracle } from '../lib/tex-repair.js'
import { createBlockState, guardStream, apply, TOKEN } from '../lib/guard.js'

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
    // The doubled subscript is the one defect the guard REWRITES rather than reframes: the
    // renderer echoed `x_1_2` and grouping the rest (`x_{1_2}`) is the same mathematics the
    // author wrote, so the reader gets a rendered formula instead of a shout in red. What
    // must survive is therefore the grouped form, not the broken spelling.
    'double subscript',
    '设 $x_1_2$ 表示坐标。',
    'x_{1_2}',
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
console.log('\n=== C2. a repair must never break the Markdown structure around it ===\n')

// Reported from a real session: the answer presented the double subscript `x_1_2` as a TABLE,
// and the guard's fallback — a fenced block, which is a multi-line construct — landed inside a
// table row. GFM ends the row where the block starts, so one cell became three fragments and
// the red the guard was removing came back in the wreckage. Two separate defects produced that:
// KaTeX echoes a DOUBLE SUBSCRIPT without the <mtext> wrapper the recovery path looked for, so
// the recoverable case fell through to the fence; and the fence was emitted for an INLINE
// region, where a block construct cannot belong.
const tableCell = '| `x_1_2` | $x_1_2$ | 嵌套，$x_{1_2}$ |'
const cellRepair = repairText(tableCell)

check(
  'a double subscript is repaired, not fenced',
  cellRepair.text.includes('$x_{1_2}$'),
  `emitted ${JSON.stringify(cellRepair.text)}`,
)
check(
  'the repaired cell keeps the row on one line',
  !cellRepair.text.includes('\n'),
  `the replacement introduced a line break: ${JSON.stringify(cellRepair.text)}`,
)
check(
  'the table row still has all three cells',
  (cellRepair.text.match(/\|/g) ?? []).length >= 4,
  `the row lost cells: ${JSON.stringify(cellRepair.text)}`,
)
check(
  'the repaired cell contains no rejected region',
  findMathRegions(cellRepair.text).every((r) => inspect(r).verdict === 'ok'),
  `still rejected: ${JSON.stringify(findMathRegions(cellRepair.text).map((r) => inspect(r).reason))}`,
)

// The same rule for a region that CANNOT be recovered: inline framing must stay inline.
const inlineHopeless = '| 公式 | 说明 |\n| --- | --- |\n| $\\frac{1}{2$ | 未闭合 |'
const inlineRepair = repairText(inlineHopeless)
check(
  'an unrecoverable INLINE region is not fenced either',
  !inlineRepair.text.includes('```'),
  `a block fence landed inside the table: ${JSON.stringify(inlineRepair.text)}`,
)
check(
  'the unrecoverable inline source is still shown',
  inlineRepair.text.includes('\\frac{1}{2'),
  `the source was dropped: ${JSON.stringify(inlineRepair.text)}`,
)
check(
  'the unrecoverable inline region leaves no newlines behind',
  !inlineRepair.text.includes('\n\n'),
  `blank lines were introduced: ${JSON.stringify(inlineRepair.text)}`,
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

// === E2. a release must not land inside an unclosed code span ===
//
// A `$` means one thing inside backticks and another outside them, so a release point
// inside an unclosed span settles text that the next release re-reads differently. Found
// on a real recorded turn: the release landed just before the closing backtick of
// `` `$x_1_2$` ``, the fragment was repaired as an unterminated region (removing the `$`),
// and every later release then disagreed with what was already on screen — the guard held
// the rest of the answer forever. Measured cost in that turn: 199 holds and 1391 of 2213
// characters never delivered, which the reader sees as an answer that stops mid-sentence.
const prose = '这是一段足够长的正文文字，用来把释放点推到公式之后，让释放规则真正生效。'
const spanFixture = `$x_1_2$\n\n${prose}${prose}\n\n所以我这行 \`$x_1_2$\` 在出站时会被定点改写。\n\n${prose}`
const spanLines = []
{
  const state = createBlockState({ log: (line) => spanLines.push(line), repairMode: 'auto' })
  const chunks = []
  for (let i = 0; i < spanFixture.length; i += 7) chunks.push(spanFixture.slice(i, i + 7))
  let deliveredText = ''
  for (const chunk of chunks) deliveredText += state.push(chunk)
  deliveredText += state.finish()
  const holds = spanLines.filter((l) => /holding/.test(l)).length
  console.log(`  fixture: ${spanFixture.length} chars in, ${deliveredText.length} chars out, ${holds} hold(s)`)
  check('nothing is held back when the release falls inside an open span', holds === 0, `${holds} hold(s) logged`)
  check(
    'the code span arrives whole',
    deliveredText.includes('`$x_1_2$`'),
    'the literal sample lost a `$` — the guard edited the text it must leave alone',
  )
  check(
    'the tail of the answer arrives',
    deliveredText.trimEnd().endsWith('让释放规则真正生效。'),
    `delivered text ends with ${JSON.stringify(deliveredText.slice(-30))}`,
  )
  check(
    'the formula outside the span is still repaired',
    deliveredText.includes('$x_1_2$'.replace('$x_1_2$', '$x_1_2$')) &&
      /^\$x_\{1_2\}\$/m.test(deliveredText),
    'the inline region before the span was not regrouped',
  )
}

// ---------------------------------------------------------------------------
// The host sees this class of bug as "the plugin loads and nothing happens", because a
// section that throws is dropped without a trace. So the text function is called here on
// every documented shape of `AssembleContext`, including the one with no initiator on it.
console.log('\n=== F. the prompt rules are decided per session ===\n')

/** The initiator the section's text function will be handed, as the host sets it per turn. */
const INITIATOR = { id: 'session-under-test', variable: undefined }

/**
 * Mount the plugin on a host-shaped context whose only real service is the prompt registry.
 *
 * `agents.currentInitiator()` reads the shared `INITIATOR` on every call, so a test can change
 * which session the host claims to be assembling — that is the whole input to the decision.
 */
async function mountPromptHost(config = {}) {
  const sections = []
  const logs = []
  const listeners = []
  const ctx = {
    get(name) {
      if (name === 'logger') return { info: (line) => logs.push(line) }
      if (name === 'agents') return { currentInitiator: () => INITIATOR }
      if (name === 'systemPrompt') {
        return {
          section(spec) {
            sections.push(spec)
            return () => {}
          },
        }
      }
      return undefined
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
  }
  await apply(ctx, config)
  const section = sections[0]
  // The host assembles by calling the registered text; a section with a plain string never
  // sees a session, so the call below is also a check that the registration form is right.
  const assemble = (context = { get: ctx.get }) => (typeof section?.text === 'function' ? section.text(context) : section?.text)
  return { sections, logs, listeners, section, assemble }
}

/** Drive a request through the registered listener and drain whatever it returns. */
async function passRequest(listener, options) {
  const stream = listener(options, async function* () {
    yield { type: 'text-delta', index: 0, text: '结论：S≈1.5498。' }
  })
  for await (const chunk of stream) void chunk
}

const mathsTurn = {
  model: 'test',
  sessionId: INITIATOR.id,
  messages: [{ role: 'user', content: [{ type: 'text', text: '波动方程的通解是 $$u=f(x-at)$$' }] }],
}
const proseTurn = {
  model: 'test',
  sessionId: INITIATOR.id,
  messages: [{ role: 'user', content: [{ type: 'text', text: '帮我写一首关于秋天的短诗。' }] }],
}

{
  const host = await mountPromptHost({ promptRules: 'auto' })
  check('the section is registered in auto mode', host.sections.length === 1 && host.sections[0].name === 'math-output-format', JSON.stringify(host.sections.map((s) => s.name)))
  check('its text is a function, not a frozen string', typeof host.sections[0]?.text === 'function', typeof host.sections[0]?.text)

  check('a prose session is given no rules', host.assemble() === '', JSON.stringify(host.assemble().slice(0, 40)))

  await passRequest(host.listeners[0].handler, proseTurn)
  check('a prose turn does not mark the session', host.assemble() === '', JSON.stringify(host.assemble().slice(0, 40)))

  await passRequest(host.listeners[0].handler, mathsTurn)
  const marked = host.assemble()
  check('a maths turn marks the session', marked.includes('$$') && marked.includes(TOKEN), JSON.stringify(marked.slice(0, 60)))
  check('and the decision is logged once', host.logs.filter((l) => /prompt rules now apply/.test(l)).length === 1, JSON.stringify(host.logs.filter((l) => /prompt rules/.test(l))))

  // The stickiness is what keeps the system prompt a stable cache prefix: the same session
  // must get the same text on every later step, including a step with no maths in it.
  await passRequest(host.listeners[0].handler, proseTurn)
  check('a later prose turn in a marked session still gets them', host.assemble() === marked, JSON.stringify(host.assemble().slice(0, 40)))

  INITIATOR.id = 'another-session'
  check('a different session does not', host.assemble() === '', JSON.stringify(host.assemble().slice(0, 40)))
  INITIATOR.id = 'session-under-test'
}

{
  const host = await mountPromptHost({ promptRules: 'auto' })
  const noInitiator = { get: (name) => (name === 'agents' ? { currentInitiator: () => undefined } : undefined) }
  check('an assembly with no initiator gets nothing but says so', host.assemble(noInitiator) === '' && host.logs.some((l) => /no initiator on this assembly/.test(l)), JSON.stringify(host.logs))
}

{
  const host = await mountPromptHost({ promptRules: 'full' })
  check('full still gives every session the rules', host.listeners.length === 1 && host.assemble().includes('$$'), JSON.stringify(host.assemble().slice(0, 40)))
  await passRequest(host.listeners[0].handler, proseTurn)
  check('full is unaffected by any turn', host.assemble().includes('$$'))
}

{
  const host = await mountPromptHost({ promptRules: 'minimal' })
  const text = host.assemble()
  check('minimal keeps the two load-bearing rules and the marker out', text.includes('$$') && !text.includes(TOKEN), JSON.stringify(text))
}

{
  const host = await mountPromptHost({ promptRules: 'off' })
  check('off registers nothing', host.sections.length === 0 && host.logs.some((l) => /prompt rules disabled/.test(l)), JSON.stringify(host.sections.length))
}

{
  const host = await mountPromptHost({ promptRules: 'auto' })
  await passRequest(host.listeners[0].handler, { model: 'test', messages: [] })
  check('a request the guard cannot read does not throw or mark', host.assemble() === '', JSON.stringify(host.assemble().slice(0, 40)))
}

// ---------------------------------------------------------------------------
console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  - ${f}`)
}
process.exitCode = fail === 0 ? 0 : 1
void judge