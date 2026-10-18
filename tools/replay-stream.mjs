/**
 * Prove the streaming guard delivers, on real recorded text, exactly what one pass would.
 *
 * The unit and fuzz tests use strings written for the purpose. This tool closes the other half:
 * it takes answers that are **already in the transcript**, feeds each through `createBlockState`
 * in small deltas — the way a live turn arrives — and compares the delivered text with
 * `repairText` over the finished answer. The two must be identical, and the release must never
 * need to hold text back.
 *
 * Why it exists: the defects that cost the most time here were invisible to fixtures because
 * they depended on where a release happened to land relative to structure that started earlier
 * in the answer. On 2026-10-18 this replay found one: the pending fragment began with the
 * closing ``` of a `latex` block, the scanner read those backticks as an *opening* fence, found
 * no formula behind them, and the release landed one character into `$x_{1_{2_{3}}}$` — so the
 * repair deleted that `$` and the reader lost it (`session-c00d0857`, 1168 characters). No
 * hand-written fixture had that shape.
 *
 * Usage:
 *   node tools/replay-stream.mjs                 # every recorded answer carrying a delimiter
 *   node tools/replay-stream.mjs --size 3        # delta size (default 7)
 *   node tools/replay-stream.mjs --session c00d0857
 *   node tools/replay-stream.mjs --verbose       # print each answer that was repaired
 *
 * Exit code is 1 when any answer fails, so this can be wired into a check later.
 */

import { listSessions, findSession } from './sessions.mjs'
import { readSessionRecords } from './zstd-frames.mjs'
import { createBlockState, TOKEN } from '../lib/guard.js'
import { loadOracle, repairText, findMathRegions } from '../lib/tex-repair.js'

const args = process.argv.slice(2)
const size = Number(args[args.indexOf('--size') + 1]) || 7
const sessionArg = args.includes('--session') ? args[args.indexOf('--session') + 1] : null
const verbose = args.includes('--verbose')

const textOf = (rec) =>
  (rec.data?.message?.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')

/** Every recorded answer (newest session first) that could hold a maths region. */
function answersWithMath(filter) {
  const out = []
  const sessions = filter ? [findSession(filter)].filter(Boolean) : listSessions()
  for (const s of sessions) {
    let recs
    try {
      recs = readSessionRecords(s.file)
    } catch {
      continue
    }
    for (const rec of recs) {
      if (rec.type !== 'assistant/message') continue
      const text = textOf(rec).split(TOKEN).join('')
      if (!text) continue
      if (!text.includes('$') && !text.includes('\\(') && !text.includes('\\[')) continue
      out.push({ answer: text, session: s.sessionId })
    }
  }
  return out
}

/**
 * Re-check the reader's closing rule on emitted text.
 *
 * The renderer tokenizes `$$` itself and only closes a block at a `$$` that sits alone on its
 * line; a block opened (`$$x=1`) or closed (`x=1$$`) on a content line swallows everything up
 * to the next lone `$$` and paints all of it red. The plugin's own pairing cannot see that —
 * `judge(body, true)` is happy either way — so the rule is asserted here, structurally, on
 * every answer this tool replays. `session-5cc2fbd3` (2026-10-18) is the incident.
 */
function fenceViolations(text) {
  const bad = []
  for (const region of findMathRegions(text)) {
    if (region.kind !== 'display' || !region.body.includes('\n')) continue
    if (text.slice(region.start + 2).split('\n')[0].trim() !== '') bad.push('opening fence not alone')
    if (region.end - 3 >= 0 && text[region.end - 3] !== '\n') bad.push('closing fence not at line start')
    if (text.slice(region.end).split('\n')[0].trim() !== '') bad.push('closing fence not alone')
  }
  return bad
}

await loadOracle()
const targets = answersWithMath(sessionArg)
if (targets.length === 0) {
  console.log('no recorded answer carries a maths delimiter')
  process.exit(0)
}

let failures = 0
let repaired = 0
let fenceDefects = 0
let degraded = 0
const started = performance.now()
for (const { answer, session } of targets) {
  const lines = []
  const state = createBlockState({ log: (line) => lines.push(line), repairMode: 'auto' })
  let delivered = ''
  for (let i = 0; i < answer.length; i += size) delivered += state.push(answer.slice(i, i + size))
  delivered += state.finish()

  const once = repairText(answer)
  const problems = []
  // A block that blows through `maxHold` inside an unclosed code span is released verbatim
  // from that point on — a documented degradation (never lose text), so the one-pass result is
  // not the right yardstick for those answers. What must still hold is that the tail arrives.
  const frozen = lines.some((l) => /releasing the rest of this block unrepaired/.test(l))
  if (frozen) degraded += 1
  if (delivered !== once.text && !frozen) {
    const at = [...delivered].findIndex((c, i) => c !== once.text[i])
    problems.push(`differs from one pass at ${at}: ${JSON.stringify(delivered.slice(Math.max(0, at - 20), at + 20))}`)
  }
  if (frozen) {
    const tail = answer.slice(Math.max(0, answer.length - 120))
    if (!delivered.endsWith(tail)) problems.push(`frozen tail was not delivered verbatim: ${JSON.stringify(delivered.slice(-40))}`)
  }
  const held = lines.filter((l) => /holding/.test(l))
  if (held.length) problems.push(`${held.length} hold(s)`)
  const backstop = lines.filter((l) => /could not be released/.test(l))
  if (backstop.length) problems.push(`${backstop.length} verbatim tail release(s)`)
  const fences = fenceViolations(once.text)
  if (fences.length) problems.push(`fence rule violated: ${fences.join(', ')}`)
  if (once.repairs.some((r) => r.reason === 'display-fence-not-alone')) fenceDefects += 1
  if (once.repairs.length) repaired += 1

  const tag = `${session.split('-')[1] ?? session} ${answer.length}ch`
  if (problems.length) {
    failures += 1
    console.log(`FAIL  ${tag}\n        ${problems.join('\n        ')}`)
  } else if (verbose && once.repairs.length) {
    console.log(`ok    ${tag} repaired=${once.repairs.map((r) => r.reason).join(',')}`)
  }
}

console.log(
  `\n${targets.length} answer(s) replayed at ${size}-character deltas in ` +
    `${(performance.now() - started).toFixed(0)} ms: ${failures} failed, ${repaired} repaired ` +
    `(${fenceDefects} with a display-fence defect, ${degraded} frozen)`,
)
process.exitCode = failures === 0 ? 0 : 1
