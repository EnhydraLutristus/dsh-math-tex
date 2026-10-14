// A streaming guard is only correct if the answer it produces does not depend on how
// the model happened to slice its output into deltas. This feeds the same document
// through createBlockState at every chunk size from 1 byte upward (plus random
// chunkings) and requires the reassembled stream to equal repairing the whole text in
// one pass — the invariant the whole cumulative design exists to preserve.
import { readFileSync } from 'node:fs'
import { createBlockState } from './index.js'
import { repairText } from './math-repair.js'
const TOKEN = '⟪MG-REPAIR⟫'

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) { pass++; return }
  fail++
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

/** Feed `text` through the state machine in fixed-size pieces and reassemble. */
function streamInPieces(text, size) {
  const state = createBlockState()
  let out = ''
  for (let i = 0; i < text.length; i += size) {
    out += state.push(text.slice(i, i + size))
  }
  out += state.finish()
  return out
}

/** Feed `text` through with a deterministic pseudo-random chunk sequence. */
function streamRandom(text, seed) {
  const state = createBlockState()
  let out = ''
  let i = 0
  let s = seed
  while (i < text.length) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const size = 1 + (s % 17)
    out += state.push(text.slice(i, i + size))
    i += size
  }
  out += state.finish()
  return out
}

const fixture = readFileSync(new URL('./real-broken.txt', import.meta.url), 'utf8')
// The real incident carried the sentinel-wrapped region; add the markers the model is
// instructed to emit so the same path is exercised on real content.
const oneRegion = `前言文字，先说明一下。\n\n${TOKEN}\n${fixture}\n${TOKEN}\n\n后面还有结论。\n`
const twoRegions = `${oneRegion}\n${TOKEN}\n第二个区域：$$\\frac{a}{b}$ 结束。\n${TOKEN}\n收尾。\n`

// The reference answer: what the composed path produces in one pass. Sentinel removal
// belongs to the block layer and region repair to the math layer, so neither
// `repairText` nor a bare split reproduces it; feeding the whole document as a single
// delta does, and it is the composition — not an aesthetic — that the chunkings must
// agree with.
const referenceOne = streamInPieces(oneRegion, 1 << 20)
const referenceTwo = streamInPieces(twoRegions, 1 << 20)

check('single-pass repair removes the sentinel', !referenceOne.includes(TOKEN))
check('single-pass repair keeps the prose', referenceOne.includes('前言文字'))
check('single-pass repair keeps the trailing prose', referenceOne.includes('后面还有结论。'), JSON.stringify(referenceOne.slice(-40)))
check('two-region reference keeps the second region', referenceTwo.includes('第二个区域'))

// Every fixed chunk size, including the pathological 1-byte case where every
// multi-byte delimiter and the 16-char sentinel are split across deltas.
const sizes = []
for (let s = 1; s <= 40; s++) sizes.push(s)
for (const s of [48, 61, 97, 128, 200, 333, 512, 1024]) sizes.push(s)

for (const size of sizes) {
  const got = streamInPieces(oneRegion, size)
  check(`chunk=${size} reassembles to the single-pass answer`, got === referenceOne, `got ${got.length} chars, want ${referenceOne.length}`)
}

for (const size of sizes) {
  const got = streamInPieces(twoRegions, size)
  check(`two regions, chunk=${size} reassembles`, got === referenceTwo, `got ${got.length} chars, want ${referenceTwo.length}`)
}

for (let seed = 1; seed <= 40; seed++) {
  const got = streamRandom(twoRegions, seed)
  check(`random chunking seed=${seed} reassembles`, got === referenceTwo, `got ${got.length} chars, want ${referenceTwo.length}`)
}

// No chunking may ever leak the sentinel into the answer.
for (const size of sizes) {
  const got = streamInPieces(twoRegions, size)
  check(`chunk=${size} leaks no sentinel`, !got.includes(TOKEN))
}

// A document with no sentinel at all must survive every chunking byte-identically.
const plain = `普通回答，没有哨兵。\n\n$$\nu=\\frac12[\\varphi(1)+\\varphi(1)]\n$$\n\n结论：0.367879。\n`
for (const size of sizes) {
  const got = streamInPieces(plain, size)
  check(`plain text, chunk=${size} is byte-identical`, got === plain, `got ${JSON.stringify(got.slice(0, 60))}`)
}

console.log(`\n=== FUZZ RESULT: ${pass} passed, ${fail} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const f of failures.slice(0, 25)) console.log(`  - ${f}`)
  process.exitCode = 1
}
