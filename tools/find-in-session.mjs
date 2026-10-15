#!/usr/bin/env node
/**
 * 在会话记录里搜"坏文本"，看守护到底有没有把它洗干净。
 *
 * RUN:
 *   node tools/find-in-session.mjs --unterminated [--session be07dfe9] [--context 200]
 *   node tools/find-in-session.mjs --grep '波动方程'
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { decodeAllFrames } from './zstd-frames.mjs'

const argv = process.argv.slice(2)
const pick = (flag) => { const i = argv.indexOf(flag); return i === -1 ? '' : argv[i + 1] }
const sessionNeedle = pick('--session')
const grepNeedle = pick('--grep')
const wantUnterminated = argv.includes('--unterminated')
const context = Number(pick('--context')) || 200
const maxHits = Number(pick('--max')) || 8

const root = path.join(os.homedir(), '.dsh', 'sessions')
const files = []
for (const slug of fs.readdirSync(root)) {
  const d = path.join(root, slug)
  if (!fs.statSync(d).isDirectory()) continue
  for (const id of fs.readdirSync(d)) {
    if (sessionNeedle && !id.includes(sessionNeedle)) continue
    const f = path.join(d, id, 'session.v4.jsonl.zstd')
    if (fs.existsSync(f)) files.push({ id, f, m: fs.statSync(f).mtimeMs })
  }
}
files.sort((a, b) => b.m - a.m)
if (!files.length) { console.error('no session matched', sessionNeedle || '(any)'); process.exit(2) }

/** 落单的 $：一个文本块里 $ 的个数是奇数，就说明有没配对的 */
const oddDollarSpans = (text) => {
  const marks = []
  const re = /(?<!\\)\$/g
  let m
  while ((m = re.exec(text))) marks.push(m.index)
  if (marks.length % 2 === 0) return []
  return [[marks[marks.length - 1], text.length]]
}

for (const { id, f, m } of files) {
  const text = decodeAllFrames(fs.readFileSync(f)).toString('utf8')
  const hits = []
  if (grepNeedle) {
    let i = -1
    while ((i = text.indexOf(grepNeedle, i + 1)) !== -1) hits.push({ kind: 'grep', at: i })
  }
  if (wantUnterminated) {
    for (const [a, b] of oddDollarSpans(text)) hits.push({ kind: 'odd-$', at: a, end: b })
  }
  console.log(`\n########## ${id}  (${(text.length / 1024).toFixed(0)} KB, mtime ${new Date(m).toLocaleString()})  hits=${hits.length}`)
  for (const h of hits.slice(0, maxHits)) {
    const from = Math.max(0, h.at - context)
    const to = Math.min(text.length, (h.end ?? h.at) + context)
    console.log(`--- ${h.kind} @${h.at} ---`)
    console.log(text.slice(from, to).replace(/\\n/g, '\n').replace(/\\"/g, '"'))
  }
}
