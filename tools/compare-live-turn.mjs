/**
 * Line up what the guard DID with what the transcript KEPT.
 *
 * The guard logs `repaired N region(s)` and `guarded stream: A in, B out` as a turn streams.
 * The transcript is written by the host afterwards. Nothing so far compares the two, and that
 * seam is exactly where a guard can look healthy and still leave red text on screen.
 *
 * The transcript carries no wall-clock stamp (records hold `seq`, `turn`, `step` only), so the
 * two sides are lined up by shape rather than by time: this prints every message the guard
 * says it repaired, in order, then walks the transcript from the end and reports which
 * messages still hold a region the renderer rejects.
 *
 * RUN: node tools/compare-live-turn.mjs [sessionIdPrefix] [--last N]
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { dshHome, sessionsRoot, findSession } from './sessions.mjs'
import * as plugin from '../lib/index.js'

const args = process.argv.slice(2)
const last = args.includes('--last') ? Number(args[args.indexOf('--last') + 1]) : 0
const idArg = args.find((a) => !a.startsWith('--') && a !== String(last))

const found = findSession(idArg)
if (!found) {
  console.error(`no session matching ${idArg ?? '(newest)'} under ${sessionsRoot()}`)
  process.exit(1)
}

/* --- decode the zstd-framed transcript ---------------------------------- */

function records(file) {
  const buf = readFileSync(file)
  const out = []
  for (let pos = 0; pos < buf.length - 3; pos += 1) {
    if (buf[pos] !== 0x28 || buf[pos + 1] !== 0xb5 || buf[pos + 2] !== 0x2f || buf[pos + 3] !== 0xfd) continue
    let text
    try {
      text = zlib.zstdDecompressSync(buf.subarray(pos)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // a partial line at a frame boundary; the record appears in the next frame
      }
    }
  }
  const bySeq = new Map()
  for (const r of out) if (r && r.seq !== undefined) bySeq.set(r.seq, r)
  return [...bySeq.values()]
}

const textOf = (r) => (r.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')

function flagged(text) {
  const out = []
  for (const region of plugin.findMathRegions(text.split(plugin.TOKEN).join(''))) {
    const v = plugin.inspect(region)
    if (v && v.verdict !== 'ok') out.push({ reason: v.reason, body: region.body })
  }
  return out
}

/* --- the guard's own log ------------------------------------------------ */

function guardLog() {
  const candidates = [
    process.env.DSH_MATH_TEX_LOG,
    join(dshHome() ?? '.', 'profiles', 'desktop', 'dsh-math-tex.log'),
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      return { path: p, lines: readFileSync(p, 'utf8').trim().split('\n') }
    } catch {
      // try the next candidate
    }
  }
  return { path: null, lines: [] }
}

const log = guardLog()
console.log(`session ${found.sessionId}  (${found.workspace})`)
console.log(`log     ${log.path ?? 'not found'}`)

console.log('\n=== what the guard did, as it did it ===')
for (const line of log.lines) {
  if (/repaired|guarded stream/.test(line)) console.log(`  ${line}`)
}

console.log('\n=== what the transcript kept (newest first) ===')
const allRows = records(found.file).filter((r) => r.type === 'assistant/message' && textOf(r).trim())
const rows = (last > 0 ? allRows.slice(-last) : allRows).reverse()

let dirty = 0
for (const r of rows) {
  const text = textOf(r)
  const bad = flagged(text)
  if (bad.length > 0) dirty += 1
  const mark = bad.length === 0 ? 'clean' : `*** ${bad.length} RED ***`
  console.log(`  seq ${String(r.seq).padStart(5)}  turn ${String(r.turn ?? '?').padStart(3)}  ${String(text.length).padStart(6)} chars  ${mark}`)
  for (const b of bad.slice(0, 2)) console.log(`        [${b.reason}] ${JSON.stringify(b.body.slice(0, 80))}`)
}

console.log(`\n  ${rows.length} assistant message(s), ${dirty} with a region that renders red`)
console.log(`  guard log: ${log.lines.filter((l) => /repaired/.test(l)).length} repair line(s) for this session's host`)
