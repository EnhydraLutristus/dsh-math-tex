/**
 * Every recorded answer whose repair still leaves a flagged region behind.
 *
 * `repairText` is supposed to make the reader see no red formula. A leftover means the repair
 * did not converge — and because the guard repairs its own accumulated text, a leftover can
 * also mean the guard's output trips its own detector. This is the corpus-wide check for that:
 * it walks every assistant answer on this machine, repairs it, and re-inspects the result.
 *
 * It was written after an adversarial pass (1.2.9) found one synthetic shape that does not
 * converge: `这行是 $$$ 不是公式。` — the middle `$` opens a region, the trailing `$` closes it
 * immediately, and the repair drops a `$` in a way that leaves `$$ 不是公式。` unterminated.
 * The three-dollar shape does not occur in the recorded corpus at all (`--triple` prints the
 * count), which is why the fix was documented rather than guessed at.
 *
 * Usage:
 *   node tools/find-leftover.mjs            # summary; exits 1 if an answer has a leftover
 *   node tools/find-leftover.mjs --all      # print every leftover region with context
 *   node tools/find-leftover.mjs --triple   # count answers containing `$$$`
 *   node tools/find-leftover.mjs --session 4f7d
 */

import { listSessions } from './sessions.mjs'
import { readSessionRecords } from './zstd-frames.mjs'
import { repairText, inspectText, loadOracle, TOKEN } from '../lib/index.js'

const argv = process.argv.slice(2)
const showAll = argv.includes('--all')
const onlyTriple = argv.includes('--triple')
const onlySession = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : null

const textOf = (rec) =>
  (rec.data?.message?.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')

await loadOracle()

let answers = 0
let repaired = 0
let repairedWithLeftover = 0
let triple = 0
const leftovers = []
const kinds = new Map()

for (const s of listSessions()) {
  if (onlySession && !s.sessionId.includes(onlySession)) continue
  let recs
  try {
    recs = readSessionRecords(s.file)
  } catch (err) {
    console.error(`  (unreadable: ${s.sessionId.slice(0, 20)} — ${err.message})`)
    continue
  }
  for (const r of recs) {
    if (r.type !== 'assistant/message') continue
    const text = textOf(r)
    if (!text.trim()) continue
    answers += 1
    if (onlyTriple) {
      if (text.includes('$$$')) triple += 1
      continue
    }
    const stripped = text.split(TOKEN).join('')
    const result = repairText(stripped)
    if (result.repairs.length > 0) repaired += 1
    const left = inspectText(result.text).flagged
    if (!left.length) continue
    repairedWithLeftover += 1
    for (const l of left) kinds.set(l.kind, (kinds.get(l.kind) ?? 0) + 1)
    leftovers.push({ session: s.sessionId, len: stripped.length, repairs: result.repairs.length, left, text: result.text })
  }
}

if (onlyTriple) {
  console.log(`${answers} answer(s) scanned; ${triple} contain \`$$$\`.`)
  process.exit(0)
}

console.log(`${answers} answer(s) scanned; ${repaired} needed a repair; ${repairedWithLeftover} still flagged after repairing.`)
if (repairedWithLeftover) {
  console.log(`leftover kinds: ${JSON.stringify([...kinds])}`)
  for (const l of leftovers) {
    console.log(`  ${l.session.slice(0, 24)}  repairs=${l.repairs}  flagged=${l.left.length}  len=${l.len}`)
    for (const region of l.left) {
      const around = (region.raw ?? '').slice(0, 120).replace(/\n/g, '\\n')
      console.log(`    ${region.kind}: ${JSON.stringify(around)}`)
      if (!showAll) continue
      const at = l.text.indexOf(region.raw)
      const context = l.text.slice(Math.max(0, at - 60), at + (region.raw?.length ?? 0) + 60).replace(/\n/g, '\\n')
      console.log(`      …${context}…`)
    }
  }
  process.exit(1)
}
