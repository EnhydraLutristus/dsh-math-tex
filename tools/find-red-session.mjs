/**
 * Find a session whose latest answer would render red, and say what the guard did about it.
 *
 * Written for a specific report: "in the wave-equation chat, the newest reply has the old
 * problem again". Answering it needs the record, not the rendered screen, so this walks every
 * session of this workspace, decodes the zstd-framed transcript, and for each assistant text
 * block runs the plugin's own verdict (`inspect`) over its maths regions.
 *
 * Prints, per session: when it last changed, how many assistant messages it holds, how many
 * contain a region that would render red, and — for the newest few — the offending region.
 *
 * RUN: node tools/find-red-session.mjs [--all]
 *      --all   report every session, not only the newest few
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { findMathRegions, inspect, loadOracle } = await import(pathToFileURL(join(here, '..', 'lib', 'tex-repair.js')).href)
const { TOKEN } = await import(pathToFileURL(join(here, '..', 'lib', 'guard.js')).href)
/**
 * The shared frame walker, not a local one.
 *
 * This tool used to carry its own "scan for the magic, decompress from there" reader. That reader
 * silently returned NOTHING for every record appended by the current host: the record is a
 * concatenation of zstd frames, and decompressing from a magic offset stops after the first frame
 * — so it reported "0 assistant messages" for a session that visibly had answers, which reads as
 * "nothing wrong found". One decoder, one behaviour.
 */
const { readSessionRecords } = await import(pathToFileURL(join(here, 'zstd-frames.mjs')).href)

const oracle = await loadOracle()
console.log(`oracle: ${oracle.available ? `katex ${oracle.version}` : `UNAVAILABLE (${oracle.error})`}`)
if (!oracle.available) {
  console.log('without the renderer nothing can be judged — refusing to report "no red found".')
  process.exit(1)
}

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const ROOT = join(HOME, '.dsh', 'sessions')
if (!fs.existsSync(ROOT)) {
  console.error(`no sessions directory at ${ROOT}`)
  process.exit(1)
}

const textOf = (r) => (r.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')

/**
 * Every session record on this machine.
 *
 * The layout is `~/.dsh/sessions/<workspace-slug>/<sessionId>/session.v4.jsonl.zstd`, and the
 * slug is derived from the workspace path — so hard-coding one slug silently matched nothing
 * (this tool first reported "0 sessions", which reads like "nothing found" but was really
 * "looked in the wrong place"). Walk the tree instead.
 */
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
      else if (e.name === 'session.v4.jsonl.zstd') out.push({ file: p, id: path.basename(dir), mtime: fs.statSync(p).mtimeMs })
    }
  }
  walk(root, 0)
  return out.sort((a, b) => b.mtime - a.mtime)
}

const dirs = sessionFiles(ROOT)

const all = process.argv.includes('--all')
const limit = all ? dirs.length : 8
console.log(`sessions: ${dirs.length} (inspecting ${limit}, newest first)\n`)

let reported = 0
for (const { id, file, mtime } of dirs.slice(0, limit)) {
  let records
  try {
    records = readSessionRecords(file)
  } catch (err) {
    console.log(`${id}  DECODE FAILED: ${err?.message ?? err}`)
    continue
  }
  const assistants = records.filter((r) => r.type === 'assistant/message' && textOf(r).trim())
  const flagged = []
  for (const r of assistants) {
    const text = textOf(r)
    for (const region of findMathRegions(text)) {
      const v = inspect(region)
      if (v.verdict !== 'ok') {
        flagged.push({ seq: r.seq, reason: v.reason, detail: v.detail, body: region.body.slice(0, 70), mid: region.midLineDisplay })
      }
    }
  }
  const tokenLeak = assistants.filter((r) => new RegExp(`^[ \\t]*${TOKEN}[ \\t]*$`, 'm').test(textOf(r))).length
  const title = records.find((r) => r.type === 'session/title')?.data?.title ?? ''
  if (flagged.length === 0 && tokenLeak === 0 && !all) continue

  reported += 1
  console.log(`${id}`)
  console.log(`  mtime ${new Date(mtime).toISOString()}  records ${records.length}  assistant ${assistants.length}  title ${JSON.stringify(String(title).slice(0, 40))}`)
  console.log(`  regions that would render red: ${flagged.length}${tokenLeak ? `   sentinel leaked in ${tokenLeak} message(s)` : ''}`)
  for (const f of flagged.slice(0, 6)) {
    console.log(`    seq ${f.seq} [${f.reason}${f.mid ? '/midline' : ''}] ${JSON.stringify(f.body)}`)
  }
  if (flagged.length > 6) console.log(`    … and ${flagged.length - 6} more`)
  console.log('')
}

if (reported === 0) console.log('no session in the inspected set has a region that would render red')
