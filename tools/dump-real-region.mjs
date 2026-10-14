// Dump the exact stored markdown around two known-bad regions of a session, so the regression
// test can quote real text instead of a paraphrase of it.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSION = 'session-d7c78d3f-06cf-4add-95f3-aa4fa9400ef9'
const ROOT = path.join(process.env.USERPROFILE, '.dsh', 'sessions', '--C-Users-<user>-Documents-deepseek-harness-default-workspace--', SESSION)
const buf = fs.readFileSync(path.join(ROOT, 'session.v4.jsonl.zstd'))
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const bySeq = new Map()
for (let p = 0; p < buf.length - 3; p++) {
  if (!buf.subarray(p, p + 4).equals(MAGIC)) continue
  try {
    const t = zlib.zstdDecompressSync(buf.subarray(p)).toString('utf8')
    for (const line of t.split('\n')) {
      if (!line.trim().startsWith('{')) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof o.seq === 'number') bySeq.set(o.seq, o)
    }
    p += 3
  } catch {
    /* not a frame boundary */
  }
}

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
