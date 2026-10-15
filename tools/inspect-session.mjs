/**
 * Look at one session's maths regions in detail: what the renderer does with each, and what
 * the guard would do about it.
 *
 * Written to answer "the newest reply in the wave-equation chat is broken again": the summary
 * tool says which sessions have flagged regions, this one shows the actual text, the verdict,
 * and — separately — the thing a summary can hide, namely that the region scan runs per TEXT
 * BLOCK while the renderer parses the whole message. Those two are not always the same set.
 *
 * RUN: node tools/inspect-session.mjs <sessionIdPrefix> [--seq N] [--all]
 *      --seq N   only that record
 *      --all     print every assistant message, not only the flagged ones
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { readSessionRecords } from './zstd-frames.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { findMathRegions, inspect, repairText, judge, echoesError, loadOracle } = await import(
  pathToFileURL(join(here, '..', 'lib', 'tex-repair.js')).href
)

const oracle = await loadOracle()
console.log(`oracle: ${oracle.available ? `katex ${oracle.version}` : `UNAVAILABLE ${oracle.error}`}\n`)

const args = process.argv.slice(2)
const idPrefix = args.find((a) => !a.startsWith('-'))
const seqWanted = args.includes('--seq') ? Number(args[args.indexOf('--seq') + 1]) : null
const all = args.includes('--all')

if (!idPrefix) {
  console.error('usage: node tools/inspect-session.mjs <sessionIdPrefix> [--seq N] [--all]')
  process.exit(1)
}

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

const records = readSessionRecords(hit.file)
console.log(`session ${hit.id}  records ${records.length}\n`)

const blocksOf = (r) => (r.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text)

/** The product's two-arm chain, reporting which arm produced red. */
function renderVerdict(tex, displayMode) {
  try {
    const html = arguments[2]?.katex?.renderToString
      ? null
      : null
    void html
  } catch {
    /* fallthrough */
  }
  const v = judge(tex, displayMode)
  if (v.red) return `RED (${v.ok ? 'strict ok but error-coloured' : 'lenient fallback'})`
  return v.ok ? 'clean (strict)' : 'clean (lenient)'
}

for (const r of records) {
  if (r.type !== 'assistant/message') continue
  if (seqWanted !== null && r.seq !== seqWanted) continue
  const blocks = blocksOf(r)
  if (blocks.length === 0) continue

  // Two scans, deliberately: per block (what the guard sees) and over the joined message
  // (closer to what the renderer parses).
  const perBlock = blocks.flatMap((t, i) => findMathRegions(t).map((reg) => ({ i, reg })))
  const joined = blocks.join('\n\n')
  const whole = findMathRegions(joined)
  const flaggedPerBlock = perBlock.filter(({ reg }) => inspect(reg).verdict !== 'ok')
  const flaggedWhole = whole.filter((reg) => inspect(reg).verdict !== 'ok')

  if (!all && flaggedPerBlock.length === 0 && flaggedWhole.length === 0) continue

  console.log(`--- seq ${r.seq}  blocks ${blocks.length}  chars ${joined.length} ---`)
  console.log(`  per-block regions ${perBlock.length}, flagged ${flaggedPerBlock.length}`)
  console.log(`  whole-message regions ${whole.length}, flagged ${flaggedWhole.length}`)
  for (const { i, reg } of flaggedPerBlock) {
    const v = inspect(reg)
    console.log(`    [block ${i}] ${v.reason}: ${v.detail}`)
    console.log(`      body: ${JSON.stringify(reg.body.slice(0, 90))}`)
    console.log(`      renders as: ${renderVerdict(reg.body, reg.kind === 'display')}`)
    const fixed = repairText(blocks[i])
    const after = findMathRegions(fixed.text).filter((x) => inspect(x).verdict !== 'ok')
    console.log(`      guard would repair: ${fixed.repairs.length} region(s) -> ${after.length} still flagged`)
    for (const rep of fixed.repairs.slice(0, 3)) {
      console.log(`        [${rep.reason}] before ${JSON.stringify(rep.before.slice(0, 60))}`)
      console.log(`        [${rep.reason}] after  ${JSON.stringify(rep.after.slice(0, 60))}`)
    }
  }
  for (const reg of flaggedWhole) {
    if (flaggedPerBlock.some(({ reg: x }) => x.start === reg.start && x.body === reg.body)) continue
    const v = inspect(reg)
    console.log(`    [whole-message only] ${v.reason}: ${v.detail}`)
    console.log(`      body: ${JSON.stringify(reg.body.slice(0, 90))}`)
    console.log(`      renders as: ${renderVerdict(reg.body, reg.kind === 'display')}`)
  }
  console.log('')
}

void echoesError
