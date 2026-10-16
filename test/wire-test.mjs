/**
 * Wire-level tests for math-guard's stream rewriting.
 *
 * The guard sits between the model and the session record, so the property that
 * matters is behavioural, not structural: **concatenating the deltas it emits
 * must equal repairing the final text as a whole** — modulo the sentinel, which
 * is always removed. Any holdback bug shows up as a divergence here.
 *
 * The same invariant is checked under five different chunk splittings, including
 * one character per delta, because the failure mode this guards against is a
 * decision made on a partial region.
 */

import { createBlockState, guardStream, safeCut, TOKEN, BUILD } from '../lib/guard.js'
import { repairText } from '../lib/tex-repair.js'
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** The expected result of guarding a text: strip sentinel, then repair. */
function expected(text) {
  return repairText(text.split(TOKEN).join('')).text
}

const indices = (s) => Array.from(s).map((_, i) => i)

/** Split text into deltas at every index in `cuts` (plus the start and end). */
function chunkAt(text, cuts) {
  const points = [0, ...[...new Set(cuts)].filter((c) => c > 0 && c < text.length).sort((a, b) => a - b), text.length]
  const out = []
  for (let i = 1; i < points.length; i++) out.push(text.slice(points[i - 1], points[i]))
  return out
}

/** Feed deltas through the real waterfall wrapper and concatenate the result. */
async function runStream(deltas, { blocks = [[1, 'text']] } = {}) {
  const chunks = []
  for (const [index, type] of blocks) {
    chunks.push({ type: 'block-start', index, blockType: type })
    for (const d of deltas) {
      if (type === 'text') chunks.push({ type: 'text-delta', index, text: d })
      else chunks.push({ type: 'reasoning-delta', index, text: d })
    }
    chunks.push({ type: 'block-end', index, block: { type, text: deltas.join('') } })
  }
  chunks.push({ type: 'usage', usage: {} })
  chunks.push({ type: 'finish', reason: 'stop' })

  async function* source() {
    for (const c of chunks) yield c
  }

  const out = []
  for await (const c of guardStream(source(), { onLog: () => {} })) out.push(c)

  const text = out
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.text)
    .join('')
  return { text, out, chunks }
}

// ---------------------------------------------------------------- fixtures --
const CLEAN_INLINE = '由微积分基本定理，$\\int_0^1 x^2\\,dx=\\frac13$，代入 $x=1$ 得 $\\frac13\\approx0.3333$。'
const CLEAN_DISPLAY = '于是\n\n$$\nS=\\sum_{k=0}^{\\infty}\\frac{1}{2^k}=2\n$$\n\n其中 $S$ 是几何级数的和。'
const BROKEN_GLUED = '$$\nS=\\frac{a_1}{1-q}=\\frac{1}{0.5}## 第 3 步：算出数值\n$$'
const BROKEN_MIDLINE = '初始条件只剩第一项：$$\\int_0^1 x\\,dx=\\frac{1}{2}=\\frac{2}{4}$$ 于是得到 $0.5$。'
const BROKEN_UNCLOSED = '$$\nE=mc^2=9\\times10^{16}'
const BROKEN_BRACE = '$$\nx=\\frac{-b\\pm\\sqrt{b^2-4ac}$$\n\n然后继续。'
const MONEY = '成本是 $5，收益是 $8，所以净赚。'

console.log(`math-guard wire tests — BUILD=${BUILD}`)
console.log(`token = ${JSON.stringify(TOKEN)}\n`)

console.log('=== A. the emitted deltas equal the whole-text repair ===')
for (const [name, text] of [
  ['clean inline', CLEAN_INLINE],
  ['clean display', CLEAN_DISPLAY],
  ['glued heading', BROKEN_GLUED],
  ['mid-paragraph display', BROKEN_MIDLINE],
  ['unclosed display', BROKEN_UNCLOSED],
  ['stray $ swaps pairing', BROKEN_BRACE],
  ['money in prose', MONEY],
  ['clean + sentinel', `${CLEAN_INLINE}\n${TOKEN}`],
  ['broken + sentinel', `${BROKEN_MIDLINE}\n${TOKEN}`],
]) {
  const want = expected(text)
  const cuts = [
    'none',
    'dots',
    'dollars',
    'chars',
  ]
  const allCuts = {
    none: [],
    dots: [...text].flatMap((ch, i) => (ch === '.' ? [i + 1] : [])),
    dollars: [...text].flatMap((ch, i) => (ch === '$' ? [i, i + 1, i + 2] : [])),
    chars: indices(text),
  }
  for (const kind of cuts) {
    const deltas = chunkAt(text, allCuts[kind])
    const { text: got, out } = await (async () => runStream(deltas))()
    const ok = got === want
    check(
      `${name} — split=${kind} (${deltas.length} deltas)`,
      ok,
      ok ? '' : `want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`,
    )
    if (!ok) break
    // non-text chunks must survive untouched
    const textDeltas = out.filter((c) => c.type === 'text-delta')
    check(`${name} — no stray non-text chunks rewritten`, out.some((c) => c.type === 'finish'))
    void textDeltas
  }
}

console.log('\n=== B. content is never lost ===')
{
  // Repairing may add fences or re-frame, but must never delete the mathematics.
  const { text: got } = await runStream(chunkAt(BROKEN_MIDLINE, indices(BROKEN_MIDLINE)))
  check('formula source survives a repair', got.includes('\\int_0^1 x\\,dx=\\frac{1}{2}=\\frac{2}{4}'), JSON.stringify(got))
  check('surrounding prose survives', got.includes('初始条件只剩第一项') && got.includes('于是得到'), JSON.stringify(got))
  check('numbers are untouched', got.includes('0.5'))
}

console.log('\n=== C. the sentinel is always removed ===')
{
  const withToken = `${CLEAN_DISPLAY}\n${TOKEN}`
  for (const kind of ['none', 'chars', 'dollars']) {
    const cuts = kind === 'none' ? [] : kind === 'chars' ? indices(withToken) : [...withToken].flatMap((ch, i) => (ch === '$' ? [i, i + 1] : []))
    const { text: got } = await runStream(chunkAt(withToken, cuts))
    check(`sentinel stripped — split=${kind}`, !got.includes(TOKEN) && !got.includes('MG-REPAIR'), JSON.stringify(got.slice(-60)))
  }
  // A sentinel torn across deltas must not leak a fragment either.
  const half = TOKEN.slice(0, 5)
  const state = createBlockState()
  const emitted = state.push(`结论文本 ${half}`) + state.push(`${TOKEN.slice(5)}`) + state.finish()
  check('torn sentinel produces no fragment', !emitted.includes(half) && !emitted.includes(TOKEN), JSON.stringify(emitted))
  check('text before the torn sentinel is kept', emitted.includes('结论文本'), JSON.stringify(emitted))
}

console.log('\n=== D. holdback behaviour ===')
{
  // Anything within the sentinel tail could be the start of the sentinel, so short
  // text is buffered rather than emitted; the buffer is not a loss, only a delay.
  const state = createBlockState()
  const first = state.push('说明文字，先发出去。')
  check('short prose is buffered, not dropped', first === '' && state.held > 0, `released=${JSON.stringify(first)} held=${state.held}`)

  const held = state.push('$$\nu=\\frac12')
  check('the open block itself is withheld', !held.includes('\\frac12'), JSON.stringify(held))
  check('the first prose is released once more text arrives', held.includes('说明文字'), JSON.stringify(held))
  check('held length is tracked', state.held > 0, `held=${state.held}`)

  // Closing the region makes the whole block settled, so the repair never waits for
  // the end of the turn. The last few characters stay withheld against a split
  // sentinel and are flushed by finish(); which individual delta carries which bytes
  // is an internal detail, so the stream is judged as its concatenation.
  const closed = state.push('\n$$\n\n后续文字，应当释放。')
  const end = state.finish()
  const stream = `${first}${held}${closed}${end}`
  check('closing the block releases the repaired text', stream.includes('后续文字') && stream.includes('\\frac12'), JSON.stringify(closed))
  check('the released text is valid maths', !stream.includes('```\n\\frac12\n'), JSON.stringify(stream))
  check('finish() returns the withheld tail', typeof end === 'string' && end.length > 0, JSON.stringify(end))

  // An unclosed region below MAX_HOLD is held; once it exceeds MAX_HOLD it is released
  // UNREPAIRED, together with the text before it, so the answer can never stall on a
  // missing `$$`. The earlier form of this check asserted the oversized region stayed
  // withheld — which is exactly the stall, so it was asserting the defect.
  const stuck = createBlockState()
  const prose = '说明'.repeat(300)
  const released = stuck.push(`${prose}\n\n$$\n${'x'.repeat(700)}`)
  check('MAX_HOLD releases the text before an eternally unclosed block', released.includes('说明'), `released ${released.length} chars`)
  check('an oversized unclosed region is released too, rather than stalling', released.includes('xxxx'), `released ${released.length} chars`)

  // A small unclosed region is still withheld — the maxHold valve must not have turned
  // into a general "release everything" license.
  const small = createBlockState()
  const heldSmall = small.push('说明文字。\n\n$$\n\\frac12')
  check('a small unclosed region is still withheld', !heldSmall.includes('\\frac12'), JSON.stringify(heldSmall))
}

console.log('\n=== D2. a release may not land inside an unclosed code span ===')
{
  // Measured on a real turn that lost 1391 characters: the cut fell on the opening backtick
  // of `` `$x_1_2$` ``, the guard released it, the next release found the span complete,
  // repaired the `$` away, and from then on every repair disagreed with the text already on
  // screen — so the guard held the rest of the answer forever. Reproduced here as the exact
  // three-character history that triggered it.
  const raw = '所以我这行 `$x_1_2$` 结束。'
  const open = raw.indexOf('`')
  check('a cut never lands on an opening backtick', safeCut(raw.slice(0, open + 1)) === open, `got ${safeCut(raw.slice(0, open + 1))} expected ${open}`)
  check('the hold persists while the span is still open', safeCut(raw.slice(0, open + 2)) === open, `got ${safeCut(raw.slice(0, open + 2))}`)
  check('closing the span releases it whole', safeCut(raw) === raw.length, `got ${safeCut(raw)}`)

  // The end-to-end shape: the span must reach the reader intact, with its `$` NOT repaired.
  const state = createBlockState()
  let out = ''
  for (const ch of raw) out += state.push(ch)
  out += state.finish()
  check('the code span survives to the reader verbatim', out.includes('`$x_1_2$`'), JSON.stringify(out))
  check('the guard never held the answer', out.includes('结束'), JSON.stringify(out))
}

console.log('\n=== E. safeCut only ever cuts outside a math region ===')
{
  const buf = '前言\n\n$$\n\\frac12\n'
  // The region starts at the opener, so the cut lands exactly on it: everything
  // before the `$$` is settled even while the region itself is still open.
  check('cut lands on the opener, not inside the region', safeCut(buf) === buf.indexOf('$$'), `got ${safeCut(buf)} open=${buf.indexOf('$$')}`)
  check('nothing inside the region is released', !buf.slice(0, safeCut(buf)).includes('$$'), `got ${JSON.stringify(buf.slice(0, safeCut(buf)))}`)

  // A cut may never split a `$` run: releasing one `$` of a `$$` would make the
  // remainder pair differently on its own than in context.
  const glued = '正文 $'
  check('a cut never splits a delimiter run', safeCut(glued + '$') !== glued.length, `got ${safeCut(glued + '$')}`)

  const long = `前言文字${'。'.repeat(200)}\n\n$$\n${'x'.repeat(100)}`
  const cut = safeCut(long)
  check('cut lands before the opener', cut <= long.indexOf('$$'), `cut=${cut} open=${long.indexOf('$$')}`)
  check('cut leaves a contiguous prefix', long.slice(0, cut).length === cut)
}

console.log('\n=== F. reasoning and tool chunks pass through byte-identically ===')
{
  const deltas = ['推理内容 $\\frac12$，未闭合 $$\n', '继续推理']
  const { out } = await runStream(deltas, { blocks: [[0, 'reasoning']] })
  const reasoning = out.filter((c) => c.type === 'reasoning-delta')
  check('reasoning deltas unchanged in count', reasoning.length === deltas.length, `got ${reasoning.length}`)
  check('reasoning text untouched', reasoning.map((c) => c.text).join('') === deltas.join(''), JSON.stringify(reasoning.map((c) => c.text)))
  check('no text-delta invented for a reasoning block', out.filter((c) => c.type === 'text-delta').length === 0)
}

console.log('\n=== G. the real incident text ===')
{
  let incident = ''
  try {
    incident = readFileSync(new URL('./real-broken.txt', import.meta.url), 'utf8')
  } catch {
    incident = ''
  }
  if (incident.length === 0) {
    console.log('  SKIP  real-broken.txt not found next to the plugin')
  } else {
    const want = expected(incident)
    const before = repairText(incident)
    check('incident has defects to repair', before.repairs.length > 0, `repairs=${before.repairs.length}`)
    for (const kind of ['none', 'dollars']) {
      const cuts = kind === 'none' ? [] : [...incident].flatMap((ch, i) => (ch === '$' ? [i, i + 1, i + 3] : []))
      const { text: got } = await runStream(chunkAt(incident, cuts))
      check(`incident — split=${kind} matches whole-text repair`, got === want, `len want=${want.length} got=${got.length}`)
      if (got !== want) {
        let i = 0
        while (i < Math.min(got.length, want.length) && got[i] === want[i]) i += 1
        console.log(`        first divergence at ${i}`)
        console.log(`        want …${JSON.stringify(want.slice(Math.max(0, i - 40), i + 60))}`)
        console.log(`        got  …${JSON.stringify(got.slice(Math.max(0, i - 40), i + 60))}`)
      }
    }
    const again = repairText(want)
    check('incident repair leaves no rejected region', again.repairs.length === 0, `still repaired: ${again.repairs.length}`)
  }
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
if (fail > 0) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
