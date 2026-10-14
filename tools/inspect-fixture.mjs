// Structural report on a fixture: region count, defect classes, and what the guard would do.
// Usage: node tools/inspect-fixture.mjs [path]
import { readFileSync } from 'node:fs'
import { findMathRegions, inspect, repairText, loadOracle } from '../lib/tex-repair.js'

const file = process.argv[2] ?? new URL('../test/fixtures/real-broken.txt', import.meta.url)
const text = readFileSync(file, 'utf8')
const oracle = await loadOracle()
console.log(`oracle: available=${oracle.available} version=${oracle.version}`)
console.log(`file: ${String(file)}  ${text.length} chars`)

const regions = findMathRegions(text)
const bad = regions.filter((r) => inspect(r).verdict !== 'ok')
console.log(`regions: ${regions.length}  flagged: ${bad.length}`)
console.log('kinds: ' + JSON.stringify(regions.reduce((a, r) => ((a[r.kind] = (a[r.kind] ?? 0) + 1), a), {})))
console.log('midLineDisplay: ' + regions.filter((r) => r.midLineDisplay).length)
console.log('incomplete: ' + regions.filter((r) => !r.complete).length)
for (const r of bad) {
  console.log(`  - ${r.kind}${r.midLineDisplay ? '/midline' : ''}: ${inspect(r).reason} | ${JSON.stringify(r.body.slice(0, 48))}`)
}

const { text: out, repairs } = repairText(text)
const after = findMathRegions(out).filter((r) => inspect(r).verdict !== 'ok')
console.log(`repairs: ${repairs.length} -> ${repairs.map((r) => r.reason).join(', ')}`)
console.log(`after: ${out.length} chars, ${findMathRegions(out).length} regions, ${after.length} flagged`)
console.log(`fences: ${(out.match(/```/g) ?? []).length}`)
