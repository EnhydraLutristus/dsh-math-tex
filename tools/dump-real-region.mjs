// Dump the exact stored markdown around two known-bad regions of a session, so the regression
// test can quote real text instead of a paraphrase of it.
//
// RUN: node tools/dump-real-region.mjs [sessionId]     (no argument = newest session)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { readSessionRecords } from './zstd-frames.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { findSession, sessionsRoot } = await import(pathToFileURL(join(here, 'sessions.mjs')).href)

const found = await findSession(process.argv[2])
if (!found) {
  console.error(`no session record matching ${process.argv[2] ?? '(newest)'}`)
  console.error(`looked under ${sessionsRoot() || '(no DSH home found)'}`)
  process.exit(1)
}
console.log(`# ${found.sessionId}  (${found.workspace})\n`)

const bySeq = new Map(readSessionRecords(found.file).map((r) => [r.seq, r]))

const needles = [
  { seq: 626, needle: '是闭 1-形式', label: 'inner-delimiter-inside-text' },
  { seq: 18, needle: '\\psi(s)', label: 'plus-line-inside-display' },
]

for (const { seq, needle, label } of needles) {
  const rec = bySeq.get(seq)
  if (!rec) {
    console.log(`${label}: seq ${seq} not found`)
    continue
  }
  const text = (rec.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n')
  const at = text.indexOf(needle)
  if (at < 0) {
    console.log(`${label}: needle not found in seq ${seq}`)
    continue
  }
  const from = Math.max(0, at - 140)
  const to = Math.min(text.length, at + 140)
  console.log(`### ${label}  (seq ${seq}, region around char ${at})`)
  console.log(JSON.stringify(text.slice(from, to)))
  console.log()
}
