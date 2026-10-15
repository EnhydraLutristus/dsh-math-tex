#!/usr/bin/env node
/**
 * 会话记录的 zstd 不是"一个文件一帧"，而是每写一次追加一帧。
 * Node 自带的 zstdDecompressSync / createZstdDecompress 都只解第一帧就收工
 * （7.7 MB 的记录只能解出 249 字节的会话头），所以必须自己按帧头找边界。
 *
 * 帧头（RFC 8878）：
 *   magic 28 B5 2F FD
 *   FHD: bit7-6 内容尺寸字段长度; bit5 单段; bit3 保留(必须为0); bit1 校验和; bit0-1 字典
 *   单段(singleSegment)时没有 window descriptor，内容尺寸直接跟在 FHD 后面
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 该偏移处是不是一个合法帧头？是则返回帧头长度（自 magic 起算），否则 -1 */
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

/** 把多帧拼接的记录解成一段 Buffer；坏帧就停在它前面，保留已解出的部分 */
export const decodeAllFrames = (buf) => {
  const parts = []
  let off = 0
  while (off < buf.length) {
    const head = frameHeaderSize(buf, off)
    if (head < 0) {
      const next = buf.indexOf(MAGIC_BYTES, off + 1)
      if (next < 0) break
      off = next
      continue
    }
    let out
    try {
      out = zlib.zstdDecompressSync(buf.subarray(off), { maxOutputLength: 1 << 30 })
    } catch {
      break
    }
    parts.push(out)
    // 找下一帧：magic 还必须能当成合法帧头，避免撞上压缩数据里的巧合字节
    let cursor = off + head
    let found = -1
    while (cursor < buf.length - 4) {
      const at = buf.indexOf(MAGIC_BYTES, cursor)
      if (at < 0) break
      if (frameHeaderSize(buf, at) > 0) { found = at; break }
      cursor = at + 1
    }
    if (found < 0) break
    off = found
  }
  return Buffer.concat(parts)
}

/**
 * Decode a session record into records, de-duplicated by `seq`.
 *
 * Frames are append units, not records: a rewritten record can appear in a later frame as
 * well, so the highest `seq` wins. Every tool that reads a record needs exactly this, and
 * decoding the whole file as one buffer is strict-faster than probing every magic offset.
 *
 * @param {string} file path to a `session.v4.jsonl.zstd`
 * @returns {Array<Record<string, unknown>>} records sorted by `seq`
 */
export const readSessionRecords = (file) => {
  const text = decodeAllFrames(fs.readFileSync(file)).toString('utf8')
  const bySeq = new Map()
  const loose = []
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof o.seq === 'number') bySeq.set(o.seq, o)
    else loose.push(o)
  }
  const records = [...loose, ...bySeq.values()]
  // 只有带 seq 的才排序；不带 seq 的（会话头）保持原顺序放在最前
  const withSeq = records.filter((r) => typeof r.seq === 'number').sort((a, b) => a.seq - b.seq)
  const withoutSeq = records.filter((r) => typeof r.seq !== 'number')
  return [...withoutSeq, ...withSeq]
}
