/**
 * Zoom in on ONE region: its markdown context, the verdict, and what each candidate fix does.
 *
 * The wider tools report "flagged" and "repaired", which is not the same as "fixed": a region
 * can be flagged, handed to the repairer, and come back still unrenderable — the repair is
 * attempted and the output is never re-judged. This tool answers the only question that
 * matters for such a region: which candidate form does the renderer actually accept?
 *
 * RUN: node tools/probe-region.mjs <sessionIdPrefix> <seq> "<substring of the region>" [--context N]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { readSessionRecords } from './zstd-frames.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const lib = await import(pathToFileURL(join(here, '..', 'lib', 'tex-repair.js')).href)
const { findMathRegions, inspect, judge, repairText, loadOracle } = lib
await loadOracle()

const argv = process.argv.slice(2)
const idPrefix = argv[0]
const seqWanted = Number(argv[1])
const needle = argv[2] ?? ''
const ctx = argv.includes('--context') ? Number(argv[argv.indexOf('--context') + 1]) : 220

const ROOT = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function sessionFiles(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name === 'session.v4.jsonl.zstd') out.push({ file: p, id: path.basename(dir) })
    }
  }
  walk(root, 0)
  return out
}

const hit = sessionFiles(ROOT).find((s) => s.id.startsWith(idPrefix))
if (!hit) {
  console.error(`no session matching ${idPrefix}`)
  process.exit(1)
}

const rec = readSessionRecords(hit.file).find((r) => r.seq === seqWanted)
if (!rec) {
  console.error(`no record with seq ${seqWanted}`)
  process.exit(1)
}
const blocks = (rec.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text)
const text = blocks.join('\n\n')

const regions = findMathRegions(text)
const target = regions.find((r) => r.body.includes(needle) || r.raw.includes(needle))
if (!target) {
  console.error(`no region containing ${JSON.stringify(needle)}; regions found: ${regions.length}`)
  process.exit(1)
}

const verdict = inspect(target)
console.log(`--- region ${target.kind}${target.midLineDisplay ? '/midline' : ''} at ${target.start}..${target.end} ---`)
console.log(`verdict: ${verdict.verdict}  reason: ${verdict.reason}  detail: ${verdict.detail}`)
console.log(`\nmarkdown context:\n${JSON.stringify(text.slice(Math.max(0, target.start - ctx), target.end + ctx))}`)
console.log(`\nraw region:\n${JSON.stringify(target.raw)}`)
console.log(`\nbody (what the renderer gets):\n${JSON.stringify(target.body)}`)

const show = (label, tex, display) => {
  const v = judge(tex, display)
  console.log(`  ${label.padEnd(34)} strict=${v.ok ? 'ok' : 'FAIL'} red=${v.red ? 'YES' : 'no'}  ${v.ok ? '' : String(v.message).slice(0, 70)}`)
}

console.log('\ncandidate forms:')
show('body as display', target.body, true)
show('body as inline', target.body, false)
show('raw region as display', target.raw, true)
show('body, newlines collapsed', target.body.replace(/\n+/g, ' '), true)

// Remove plausible intruders the first fixes cannot reach.
const noDelims = target.body.replace(/(?<!\\)\$/g, '')
show('body without inner $', noDelims, true)
const noInnerTextDollar = target.body.replace(/\\text\{\$([^$]*)\$\}/g, '\\text{$1}')
show('body with $..$ unwrapped in \\text', noInnerTextDollar, true)
const noList = target.body.replace(/\n\+\s/g, '\n  + ')
show('body with list marker indented', noList, true)
const noBreak = target.body.replace(/\n\+\s/g, ' + ')
show('body with + joined to prev line', noBreak, true)

console.log('\nrepaired output for the whole block:')
const fixed = repairText(text)
console.log(`  repairs: ${fixed.repairs.map((r) => r.reason).join(', ') || '(none)'}`)
const after = findMathRegions(fixed.text)
const still = after.filter((r) => inspect(r).verdict !== 'ok')
console.log(`  after repair: ${after.length} regions, ${still.length} still flagged`)
for (const r of still.slice(0, 4)) {
  const v = inspect(r)
  console.log(`    [${v.reason}] ${JSON.stringify(r.body.slice(0, 80))}`)
  const vv = judge(r.body, r.kind === 'display')
  console.log(`      renders: strict=${vv.ok ? 'ok' : 'FAIL'} red=${vv.red ? 'YES' : 'no'}`)
}
