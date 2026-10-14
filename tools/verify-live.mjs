/**
 * Did the guard actually run on a REAL turn?
 *
 * Every other check in this package runs on text I supplied, which proves the logic but not
 * that the host ever calls it. This tool reads the evidence the host itself leaves behind:
 * the session transcript, plus the guard's own log if one is configured.
 *
 * It answers three separate questions, and keeps them separate on purpose — "the model obeyed
 * the prompt" and "the guard stripped the sentinel" are different claims, and a run can
 * satisfy one and not the other:
 *
 *   1. PROMPT  — is the formatting rule text present in the system prompt of this session?
 *   2. PERSIST — does any stored assistant text still contain the sentinel? (If yes, the
 *                stream hook did NOT run on that turn: the sentinel is the guard's job to remove.)
 *   3. RENDER  — would any maths region in the stored text render red? Stored text is what the
 *                GUI shows, so this is the claim that actually matters to a reader.
 *
 * A hit while grepping the raw transcript is NOT evidence: this tool's own source, tool
 * payloads and my prompts all contain the sentinel string. Only `assistant/message` text
 * blocks count.
 *
 * RUN: node tools/verify-live.mjs [sessionId]
 *      (no argument = the most recently modified session of this workspace)
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const lib = await import(pathToFileURL(join(here, '..', 'lib', 'tex-repair.js')).href)
const { TOKEN } = await import(pathToFileURL(join(here, '..', 'lib', 'guard.js')).href)
const { findSession, sessionsRoot, dshHome } = await import(pathToFileURL(join(here, 'sessions.mjs')).href)

// The guard's log lives wherever the profile config puts it, so "which file is it" is a search,
// not a constant: an explicit override wins, then the log the profile ships next to its config,
// then a log dropped at the workspace root by an older setup.
const LOG =
  process.env.DSH_MATH_TEX_LOG ??
  [
    join(dshHome() || '.', 'profiles', 'desktop', 'dsh-math-tex.log'),
    join(dshHome() || '.', 'profiles', 'desktop', 'math-guard.log'),
    join(here, '..', '..', 'math-guard.log'),
  ].find((p) => fs.existsSync(p)) ??
  join(dshHome() || '.', 'profiles', 'desktop', 'dsh-math-tex.log')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** The session record: many concatenated zstd frames, one per append. */
async function decode(sessionId) {
  const found = await findSession(sessionId)
  if (!found) {
    console.error(`no session record matching ${sessionId ?? '(newest)'}`)
    console.error(`looked under ${sessionsRoot() || '(no DSH home found)'}`)
    process.exit(1)
  }
  const file = found.file

  const buf = fs.readFileSync(file)
  const bySeq = new Map()
  let frames = 0
  for (let pos = 0; pos < buf.length - 3; pos++) {
    if (!buf.subarray(pos, pos + 4).equals(MAGIC)) continue
    try {
      // Each frame re-encodes a growing prefix, so records repeat across frames.
      // De-duplicate by seq and let the last occurrence win.
      const text = zlib.zstdDecompressSync(buf.subarray(pos)).toString('utf8')
      frames += 1
      for (const line of text.split('\n')) {
        if (!line.trim().startsWith('{')) continue
        let o
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        if (typeof o.seq === 'number') bySeq.set(o.seq, o)
      }
      pos += 3
    } catch {
      /* not a frame boundary */
    }
  }
  return { file, frames, records: [...bySeq.values()].sort((a, b) => a.seq - b.seq) }
}

const { file, frames, records } = await decode(process.argv[2])
console.log(`session : ${path.basename(dirname(file))}`)
console.log(`mtime   : ${new Date(fs.statSync(file).mtimeMs).toISOString()}`)
console.log(`frames  : ${frames}   records: ${records.length}\n`)

const textOf = (record) =>
  (record.data?.message?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

// --- 1. PROMPT --------------------------------------------------------------
const rule = '行间公式'
const prompted = records.filter(
  (r) =>
    (r.type === 'system/message' || r.type === 'user/message') &&
    typeof r.data?.content === 'string' &&
    r.data.content.includes(rule),
).length
console.log(`1. PROMPT   ${prompted > 0 ? 'PASS' : 'FAIL'}  the formatting rules appear in ${prompted} prompt record(s)`)
if (prompted === 0) {
  console.log('            the prompt section did not reach this session — check that the plugin is in')
  console.log('            dsh.profile.bundles AND that this session was started after that install.')
}

// --- 2. PERSIST -------------------------------------------------------------
// This one is easy to get wrong in both directions, so the rule is stated exactly.
//
// The sentinel is a made-up string, so it also turns up when someone WRITES ABOUT it: the
// first version of this check flagged my own prose quoting the marker it was searching for,
// which is the same trap as grepping the raw transcript. The prompt asks for the sentinel on
// a line of its own, so a line-shaped match is the right shape.
//
// It also has to be a LEAK for the check to mean anything. The prompt puts the receipt at the
// TOP of the reply, so a line-shaped sentinel in the opening window is a leak; one that
// appears later is text that deliberately demonstrates the marker, which is what the earlier
// probe turn did (`…你看到的不会是下面这个原词…` followed by the token). Judging those as
// failures would train me to ignore this check, which is worse than not having it.
const LINE_TOKEN = new RegExp(`^[ \\t]*${TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
const RECEIPT_WINDOW = 400
const assistants = records.filter((r) => r.type === 'assistant/message' && textOf(r).trim())
const leaks = assistants.filter((r) => {
  const i = textOf(r).search(LINE_TOKEN)
  return i >= 0 && i <= RECEIPT_WINDOW
})
const laterInProse = assistants.filter((r) => textOf(r).search(LINE_TOKEN) > RECEIPT_WINDOW)
console.log(
  `2. PERSIST  ${leaks.length === 0 ? 'PASS' : 'FAIL'}  ${leaks.length} of ${assistants.length} stored assistant message(s) open with the sentinel`,
)
for (const r of leaks.slice(0, 3)) {
  const t = textOf(r)
  const i = t.search(LINE_TOKEN)
  console.log(`            seq ${r.seq} at offset ${i}: …${JSON.stringify(t.slice(Math.max(0, i - 60), i + 40))}`)
}
if (laterInProse.length > 0) {
  console.log(`            (${laterInProse.length} message(s) carry it late in the text — a demonstration, not a receipt)`)
}
const mentioned = assistants.filter((r) => textOf(r).includes(TOKEN)).length - leaks.length - laterInProse.length
if (mentioned > 0) console.log(`            (${mentioned} message(s) merely mention the token in prose — not a leak)`)

// --- 3. RENDER --------------------------------------------------------------
// The oracle has to be up, otherwise every region would look fine for the wrong reason.
const oracle = await lib.loadOracle()
if (!oracle.available) {
  console.log(`3. RENDER   SKIP  katex unavailable (${oracle.error}) — nothing can be judged`)
} else {
  await lib.ensureOracle?.()
  const last = assistants.slice(-3)
  let regions = 0
  const bad = []
  for (const r of last) {
    const text = textOf(r)
    for (const region of lib.findMathRegions(text)) {
      regions += 1
      const verdict = lib.inspect(region)
      if (verdict.verdict !== 'ok') bad.push({ seq: r.seq, verdict: verdict.verdict, reason: verdict.reason, body: region.body.slice(0, 60) })
    }
  }
  console.log(
    `3. RENDER   ${bad.length === 0 ? 'PASS' : 'FAIL'}  ${regions} maths region(s) in the last ${last.length} stored message(s), ${bad.length} that would render red`,
  )
  for (const b of bad.slice(0, 5)) console.log(`            seq ${b.seq} [${b.verdict} ${b.reason}] ${JSON.stringify(b.body)}`)
  if (bad.length > 0) {
    console.log('            these were stored as-is: the guard did not repair them on this turn.')
    console.log('            if PERSIST also failed, the hook is not running at all.')
  }
}

// --- the guard's own log ----------------------------------------------------
console.log('')
if (fs.existsSync(LOG)) {
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n')
  const guarded = lines.filter((l) => l.includes('guarded stream:'))
  console.log(`log     : ${LOG}`)
  console.log(`          ${lines.length} line(s), ${guarded.length} turn(s) guarded`)
  for (const l of lines.slice(-6)) console.log(`          ${l}`)
  // A real turn is many deltas. `1 in, 1 out` is what a test fake stream looks like, so a log
  // where that is the only shape means the host has not called the hook yet.
  const real = guarded.filter((l) => {
    const m = /(\d+) text delta\(s\) in/.exec(l)
    return m && Number(m[1]) > 1
  })
  console.log(`          VERDICT: ${real.length > 0 ? `${real.length} real turn(s) with more than one delta — the hook runs in the host` : 'no real turn yet (every entry is a single-delta fake stream)'}`)
} else {
  console.log(`log     : ${LOG} does not exist`)
  console.log('          set `logFile` for this plugin in the profile patch to get a durable record.')
}
