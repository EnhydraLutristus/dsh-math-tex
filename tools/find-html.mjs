/**
 * Every recorded answer that carries structural HTML, across every session on this machine.
 *
 * The chat surface renders Markdown, so these tags reach the reader as literal text. The
 * guard reports them at run time (see RAW_HTML in lib/guard.js); this tool answers the other
 * direction — what the whole recorded corpus contains — which is how the pattern is checked
 * against real text instead of fixtures before it ships.
 *
 * It imports RAW_HTML rather than restating it, so what is measured here is exactly what the
 * guard will report in a live turn. Near-misses (`$a<b$`, `<T>`, `<1,2,3>`) are counted
 * separately: a single hit is printed with its context so a false positive is visible.
 *
 * Usage:
 *   node tools/find-html.mjs                 # summary per session
 *   node tools/find-html.mjs --all           # print every matching tag with context
 *   node tools/find-html.mjs --session 4f7d  # one session
 */

import { listSessions } from './sessions.mjs'
import { readSessionRecords } from './zstd-frames.mjs'
import { RAW_HTML } from '../lib/guard.js'

const argv = process.argv.slice(2)
const showAll = argv.includes('--all')
const onlySession = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : null

const textOf = (rec) =>
  (rec.data?.message?.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')

let answers = 0
let tagged = 0
const perSession = []

for (const s of listSessions()) {
  if (onlySession && !s.sessionId.includes(onlySession)) continue
  let recs
  try {
    recs = readSessionRecords(s.file)
  } catch (err) {
    console.error(`  (unreadable: ${s.sessionId.slice(0, 20)} — ${err.message})`)
    continue
  }
  const mine = recs.filter((r) => r.type === 'assistant/message' && textOf(r).trim())
  answers += mine.length
  const hits = []
  for (const a of mine) {
    const text = textOf(a)
    // Fresh regex per answer: the exported one carries no /g, and lastIndex on a shared
    // global would silently skip matches.
    const re = new RegExp(RAW_HTML.source, RAW_HTML.flags.includes('g') ? RAW_HTML.flags : RAW_HTML.flags + 'g')
    const tags = text.match(re)
    if (!tags?.length) continue
    hits.push({ tags, text })
  }
  if (!hits.length) continue
  tagged += hits.length
  perSession.push({ id: s.sessionId, answers: mine.length, hits })
  console.log(`${s.sessionId.slice(0, 24)}  answers=${mine.length}  with HTML=${hits.length}  e.g. ${hits[0].tags.slice(0, 4).join(' ')}`)
  if (showAll) {
    for (const h of hits) {
      for (const tag of h.tags) {
        const at = h.text.indexOf(tag)
        const around = h.text.slice(Math.max(0, at - 40), at + tag.length + 40).replace(/\n/g, '\\n')
        console.log(`    ${tag}  …${around}…`)
      }
    }
  }
}

console.log(`\n${answers} answer(s) scanned; ${tagged} answer(s) carry raw HTML in ${perSession.length} session(s).`)
