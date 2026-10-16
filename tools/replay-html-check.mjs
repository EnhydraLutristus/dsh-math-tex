/**
 * Prove the raw-HTML report fires on real recorded text, not only on fixtures.
 *
 * `test/guard-test.mjs` G 节 checks the pattern against strings written for the purpose. This
 * tool closes the other half: it takes an answer that is **already in the transcript** and
 * feeds it through `createBlockState` chunk by chunk — the same way a live turn arrives — so
 * the log line a future session would produce is produced here, against real text.
 *
 * Why this exists: the report is deliberately a report (the guard never edits prose), so a
 * session in which the model writes clean Markdown says nothing about whether the report
 * works. The only honest way to check it is to replay text that does contain tags.
 *
 * Usage:
 *   node tools/replay-html-check.mjs                 # the newest recorded answer carrying HTML
 *   node tools/replay-html-check.mjs 4f7db52f        # a session id (prefix)
 *   node tools/replay-html-check.mjs --all           # every recorded answer carrying HTML
 *   node tools/replay-html-check.mjs --list          # just say which answers carry HTML
 *
 * Exit code is 1 when a replayed answer with tags produced no report, so this can be wired
 * into a check later without changing it.
 */

import { listSessions, findSession } from './sessions.mjs'
import { readSessionRecords } from './zstd-frames.mjs'
import { createBlockState, RAW_HTML, TOKEN } from '../lib/guard.js'

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const all = args.includes('--all')
const idArg = args.find((a) => !a.startsWith('--'))

const textOf = (rec) =>
  (rec.data?.message?.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')

/** Every recorded answer (newest session first) that carries structural HTML. */
function answersWithHtml(filter) {
  const out = []
  const sessions = filter ? [findSession(filter)].filter(Boolean) : listSessions()
  for (const s of sessions) {
    let recs
    try {
      recs = readSessionRecords(s.file)
    } catch {
      continue
    }
    for (const r of recs) {
      if (r.type !== 'assistant/message') continue
      const text = textOf(r)
      if (!text.trim() || !RAW_HTML.test(text)) continue
      const tags = text.match(new RegExp(RAW_HTML.source, 'g'))
      out.push({ sessionId: s.sessionId, time: r.time, text, tags })
    }
  }
  return out.sort((a, b) => b.time - a.time)
}

const found = answersWithHtml(idArg)
if (found.length === 0) {
  console.log(idArg ? `no answer carrying raw HTML in session ${idArg}` : 'no answer carrying raw HTML on this machine')
  process.exit(0)
}

if (listOnly) {
  for (const f of found) {
    console.log(`${f.sessionId.slice(0, 24)}  ${new Date(f.time).toISOString()}  ${f.text.length} chars  ${f.tags.length} tag(s): ${f.tags.slice(0, 6).join(' ')}`)
  }
  process.exit(0)
}

const replay = all ? found : found.slice(0, 1)
let failures = 0
for (const f of replay) {
  const lines = []
  const state = createBlockState({ log: (line) => lines.push(line), repairMode: 'auto' })
  // The marker is stripped by design (a session in which the rules landed still ends with
  // it), so it must come off the input before "text unchanged" can mean anything.
  const expected = f.text.split(TOKEN).join('')
  let out = ''
  for (let i = 0; i < expected.length; i += 7) out += state.push(expected.slice(i, i + 7))
  out += state.finish()

  const reports = lines.filter((l) => /raw HTML/.test(l))
  const holds = lines.filter((l) => /holding/.test(l))
  const kept = out === expected
  const verdict = reports.length === 1 && kept ? 'OK' : 'FAIL'
  if (verdict === 'FAIL') failures += 1
  console.log(
    `${verdict}  ${f.sessionId.slice(0, 24)}  ${expected.length} chars in / ${out.length} out  ` +
      `${f.tags.length} tag(s)  report(s)=${reports.length}  hold(s)=${holds.length}  text unchanged=${kept}`,
  )
  if (reports.length) console.log(`      ${reports[0]}`)
  if (!kept) {
    const at = [...expected].findIndex((c, i) => c !== out[i])
    console.log(`      text differs from the first character at ${at}: ${JSON.stringify(expected.slice(Math.max(0, at - 20), at + 20))}`)
  }
}

console.log(`\n${replay.length} answer(s) replayed, ${failures} without the expected report.`)
process.exitCode = failures === 0 ? 0 : 1
