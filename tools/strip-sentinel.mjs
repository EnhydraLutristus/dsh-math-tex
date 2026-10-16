#!/usr/bin/env node
/**
 * Remove the ⟪MG-REPAIR⟫ receipt from archived session records.
 *
 * The token is the plugin's own sentinel, required by the prompt rules and stripped by the guard
 * before the text is persisted. A record can still contain it for two reasons:
 *
 *  1. it was written before 1.2.0, when the guard never ran at all (the plugin's `apply` died on
 *     the `Config` export), or
 *  2. it was written while the host was still running an older copy of the plugin in memory —
 *     installing a new version is not enough, the host process has to restart.
 *
 * Either way the text is not what the reader saw: the guard strips the sentinel on the way out, so
 * the screen was clean and only the record is noisy. This tool makes the record match the screen.
 *
 * Rewriting is deliberately conservative:
 *  - it works frame by frame, so the host can still append afterwards (a session record is a
 *    concatenation of zstd frames, one per append);
 *  - it refuses to touch a record whose lines do not survive a JSON parse/stringify round trip
 *    byte-identically, because then the rewrite would reformat records instead of stripping a token;
 *  - it verifies afterwards that every record survived and that each `seq` still appears once, and
 *    restores from the backup if anything moved.
 *
 * RUN: node tools/strip-sentinel.mjs --list
 *      node tools/strip-sentinel.mjs --id <sessionIdPrefix> --yes
 *      node tools/strip-sentinel.mjs --all --yes
 *      --where   also print which fields hold the token (files untouched)
 *      --keep-backup   keep the `.presentinel.bak` file the rewrite creates
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { readSessionRecords } = await import(pathToFileURL(join(here, 'zstd-frames.mjs')).href)
const { TOKEN } = await import(pathToFileURL(join(here, '..', 'lib', 'guard.js')).href)

const MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Frame header length at `off`, or -1 when there is no frame there (RFC 8878). */
const frameHeaderSize = (buf, off) => {
  if (off + 5 > buf.length) return -1
  if (buf.readUInt32LE(off) !== 0xfd2fb528) return -1
  const fhd = buf[off + 4]
  if ((fhd & 0x08) !== 0) return -1
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd & 0x20) !== 0
  const dictFlag = fhd & 0x03
  const dictSize = dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  return 5 + (singleSegment ? 0 : 1) + dictSize + fcsSize
}

/** Decoded text of every frame, in file order. */
function frames(file) {
  const buf = fs.readFileSync(file)
  const out = []
  let off = 0
  for (;;) {
    const head = frameHeaderSize(buf, off)
    if (head < 0) break
    out.push(zlib.zstdDecompressSync(buf.subarray(off), { maxOutputLength: 1 << 30 }).toString('utf8'))
    let cursor = off + head
    let found = -1
    while (cursor < buf.length - 4) {
      const at = buf.indexOf(MAGIC_BYTES, cursor)
      if (at < 0) break
      if (frameHeaderSize(buf, at) > 0) {
        found = at
        break
      }
      cursor = at + 1
    }
    if (found < 0) break
    off = found
  }
  return out
}

/** Every dot/bracket path in `value` whose string content holds the token. */
function tokenPaths(value, prefix = '') {
  if (typeof value === 'string') return value.includes(TOKEN) ? [prefix] : []
  if (Array.isArray(value)) return value.flatMap((v, i) => tokenPaths(v, `${prefix}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => tokenPaths(v, `${prefix}.${k}`))
  }
  return []
}

/**
 * Drop the token AND the blank line that carried it, closing the text with one trailing newline —
 * the shape the guard's own stripping leaves. Nothing else in the string moves.
 */
const strip = (text) =>
  text
    .split('\n')
    .filter((line) => line.split(TOKEN).join('').trim() !== '')
    .map((line) => line.split(TOKEN).join(''))
    .join('\n')
    .replace(/\n+$/, '\n')

/**
 * Strip the token from every string in a record.
 *
 * A transcript stores the same sentence more than once — `data.message.content[].text` and again in
 * the streamed `data.stream[].chunk.block.text` — and a pre-1.2.0 `system/message` carries the
 * requirement verbatim. Patching only the first copy is how an earlier attempt reported success
 * while every reader-visible field still held the token.
 */
const stripDeep = (value) => {
  if (typeof value === 'string') return value.includes(TOKEN) ? strip(value) : value
  if (Array.isArray(value)) return value.map(stripDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = stripDeep(v)
    return out
  }
  return value
}

function rewrite(file) {
  const joined = frames(file).join('')
  let total = 0
  let stable = 0
  for (const line of joined.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    total++
    if (JSON.stringify(JSON.parse(line)) === line) stable++
  }
  if (stable !== total) {
    console.log(`  refusing: only ${stable}/${total} record lines survive a JSON round trip unchanged`)
    return false
  }

  const before = readSessionRecords(file)
  const hits = before.filter((r) => JSON.stringify(r).includes(TOKEN)).length

  const seen = new Set()
  const patched = frames(file).map((text) => {
    const kept = []
    for (const line of text.split('\n')) {
      if (!line.trim().startsWith('{')) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      // Frame-precedence: across the whole file the LAST occurrence of a `seq` is the live one,
      // which is also what `readSessionRecords` resolves to. Keeping the first here would quietly
      // resurrect a superseded version of a record.
      if (typeof o.seq === 'number') {
        if (seen.has(o.seq)) continue
        seen.add(o.seq)
      }
      kept.push(JSON.stringify(stripDeep(o)))
    }
    return kept.length ? kept.join('\n') + '\n' : ''
  })

  const backup = `${file}.presentinel.bak`
  fs.writeFileSync(backup, fs.readFileSync(file))
  fs.writeFileSync(file, Buffer.concat(patched.map((t) => (t ? zlib.zstdCompressSync(Buffer.from(t, 'utf8')) : Buffer.alloc(0)))))

  const after = readSessionRecords(file)
  const left = after.filter((r) => JSON.stringify(r).includes(TOKEN)).length
  const sameOrder = JSON.stringify(after.map((r) => r.seq ?? null)) === JSON.stringify(before.map((r) => r.seq ?? null))
  const ok = left === 0 && sameOrder && after.length === before.length
  console.log(
    `  messages holding the token: ${hits} -> ${left}; records ${before.length} -> ${after.length}; ` +
      `order preserved: ${sameOrder ? 'yes' : 'NO'}; ${path.basename(backup)} written`,
  )
  if (!ok) {
    fs.writeFileSync(file, fs.readFileSync(backup))
    console.log('  VERIFICATION FAILED — restored from backup')
    return false
  }
  return true
}

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const ROOT = join(HOME, '.dsh', 'sessions')
if (!fs.existsSync(ROOT)) {
  console.error(`no sessions directory at ${ROOT}`)
  process.exit(1)
}

const files = []
const walk = (dir, depth) => {
  if (depth > 3) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, depth + 1)
    else if (e.name === 'session.v4.jsonl.zstd') files.push({ file: p, id: path.basename(dir), mtime: fs.statSync(p).mtimeMs })
  }
}
walk(ROOT, 0)
files.sort((a, b) => b.mtime - a.mtime)
// The workspace slug is part of the path but not of the identity users quote; show both.
const idOf = (p) => path.basename(path.dirname(p))

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const listOnly = process.argv.includes('--list') || !process.argv.includes('--yes')
const where = process.argv.includes('--where')
const idFilter = arg('--id')
const all = process.argv.includes('--all')

let scanned = 0
for (const { file, id, mtime } of files) {
  if (idFilter && !id.startsWith(idFilter)) continue
  if (!all && !idFilter && !where) continue
  scanned++
  let records
  try {
    records = readSessionRecords(file)
  } catch (err) {
    console.log(`${id}: DECODE FAILED ${err?.message ?? err}`)
    continue
  }
  const holders = records.filter((r) => JSON.stringify(r).includes(TOKEN))
  console.log(`${id}  mtime ${new Date(mtime).toISOString()}  records ${records.length}  holding the token: ${holders.length}`)
  if (where) {
    for (const r of holders) console.log(`   seq ${r.seq} ${r.type}: ${tokenPaths(r).join(', ')}`)
  }
  if (listOnly || holders.length === 0) continue
  console.log(rewrite(file) ? '  rewritten' : '  left as it was')
  if (!process.argv.includes('--keep-backup') && fs.existsSync(`${file}.presentinel.bak`)) fs.rmSync(`${file}.presentinel.bak`)
}

if (scanned === 0) {
  console.log('nothing selected — pass --id <prefix> --yes, or --all --yes')
  console.log('use --list to see which records hold the token')
}
