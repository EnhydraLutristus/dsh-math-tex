// End-to-end proof on the installed plugin.
//
// Input: the real incident text (the screenshot from the start of this conversation).
// Path: the installed guard, streamed in awkward chunk sizes.
// Verdict: the output is re-rendered by the same KaTeX the GUI uses, using the
// product's own two-arm chain, so "repaired" means "actually renders", not "looks
// different". Run from a directory where `import 'katex'` resolves to the profile copy.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// `katex` is resolved from the profile, which is where the plugin resolves it from at
// runtime. NODE_PATH does not apply to ESM, so the require is based there explicitly.
const PROFILE = 'C:/Users/<user>/.dsh/profiles/desktop'
const require = createRequire(`${PROFILE}/package.json`)
const katex = require('katex')

const DIR = 'C:/Users/<user>/.dsh/profiles/desktop/node_modules/math-guard'
const guard = await import(pathToFileURL(`${DIR}/index.js`).href)
const { repairText, findMathRegions, inspect } = await import(pathToFileURL(`${DIR}/math-repair.js`).href)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** The product's own three-arm chain, so a verdict here matches the GUI. */
function render(value, displayMode) {
  try {
    katex.renderToString(value, { displayMode, throwOnError: true })
    return 'strict-ok'
  } catch {
    try {
      katex.renderToString(value, { displayMode, strict: 'ignore', throwOnError: false })
      return 'lenient-only'
    } catch {
      return 'red-dump'
    }
  }
}

const TOKEN = guard.TOKEN
const fixture = readFileSync('C:/Users/<user>/Documents/deepseek-harness/default-workspace/plugin-design/plugin/real-broken.txt', 'utf8')
const raw = `前言，先说明一下。\n\n${TOKEN}\n${fixture}\n${TOKEN}\n\n结论：t=1.5 时 u≈0.3367，t=3 时 u≈-0.0092。\n`

console.log('=== installed guard, end to end ===')
console.log(`  katex ${katex.version}, installed BUILD=${guard.BUILD}`)

// --- the input really is broken -------------------------------------------
const regionsIn = findMathRegions(raw.split(TOKEN).join(''))
// A region is "broken" when the renderer rejects it in the framing it will actually be
// given. A `$$` that sits mid-paragraph is tokenized inline, so both framings have to
// be tried; either rejection is enough, and a rejection in both is the red-blob case.
const rejects = (r) => render(r.body, true) !== 'strict-ok' || render(r.body, false) !== 'strict-ok'
const needsRepair = regionsIn.filter((r) => inspect(r).verdict !== 'ok')
const redDumpIn = regionsIn.filter((r) => render(r.body, true) === 'red-dump' && render(r.body, false) === 'red-dump')
check('the input contains regions the guard wants to repair', needsRepair.length > 0, `${needsRepair.length}`)
check('the fixture parses (its defect is framing, not syntax)', redDumpIn.length === 0, `${redDumpIn.length} unrenderable`)
console.log(`  input: ${regionsIn.length} region(s), ${needsRepair.length} the guard repairs, ${redDumpIn.length} rejected by katex`)
console.log(`  reasons: ${[...new Set(needsRepair.map((r) => inspect(r).reason))].join(', ')}`)

// --- stream it through the installed guard at several chunk sizes ----------
for (const size of [1, 3, 7, 13, 64, 512, 100000]) {
  const state = guard.createBlockState()
  let out = ''
  for (let i = 0; i < raw.length; i += size) out += state.push(raw.slice(i, i + size))
  out += state.finish()

  const clean = out
  check(`chunk=${size}: the sentinel is gone`, !clean.includes(TOKEN))
  check(`chunk=${size}: the conclusion survived`, clean.includes('结论：t=1.5'))
  check(`chunk=${size}: no content was dropped`, clean.length >= 1000, `${clean.length} chars`)

  // The repaired regions must now pass the strict pass in both framings — that is the
  // whole point: whatever framing the renderer picks, it no longer rejects the region.
  const regions = findMathRegions(clean)
  const stillBad = regions.filter((r) => r.kind === 'display' && rejects(r))
  check(`chunk=${size}: every display region renders strictly`, stillBad.length === 0, `${stillBad.length} still bad`)
}

// --- the answer is chunking-independent -----------------------------------
const run = (size) => {
  const state = guard.createBlockState()
  let out = ''
  for (let i = 0; i < raw.length; i += size) out += state.push(raw.slice(i, i + size))
  return out + state.finish()
}
const ref = run(100000)
const varying = [1, 2, 5, 9, 17, 33, 101, 997]
const mismatched = varying.filter((s) => run(s) !== ref)
check('every chunking yields the same answer', mismatched.length === 0, `differ at ${mismatched.join(',')}`)

// --- nothing is lost, only reframed ---------------------------------------
const prose = ['前言，先说明一下。', '结论：t=1.5 时 u≈0.3367，t=3 时 u≈-0.0092。', '第 1 步', '第 2 步', '第 3 步']
const missing = prose.filter((p) => !ref.includes(p))
check('all prose survives the repair', missing.length === 0, `missing: ${missing.join(' | ')}`)
const mathKept = ['\\varphi', '\\underbrace', 'e^{-2.25}', '0.336701'].filter((t) => !ref.includes(t))
check('the mathematics itself is preserved', mathKept.length === 0, `missing: ${mathKept.join(', ')}`)

// --- the fallback is fenced, not re-parsed as maths ------------------------
const fences = (ref.match(/```/g) ?? []).length
check('rejected regions are emitted inside fences', fences >= 2, `${fences} fence markers`)

// --- negative control: text katex really cannot parse ----------------------
// The fixture above is defect-by-framing; this is defect-by-syntax, which is what the
// red blob in the report was. The repair must turn an unparseable region into text the
// renderer accepts, in whichever framing it lands in.
const nasty = [
  '# 第 1 步：分解',
  '',
  '正文里的坏公式：$$\\frac{1}{2}\\varphi(x-t)}_{\\text{右行波} ## 第 2 步：写出反射规则',
  '',
  '另一个：$\\begin{cases} a & x\\ge t \\\\ b & x<t \\end{cases}$ 未闭合收尾。',
  '',
  '结论：$u(1,1.5)=0.3367$。',
].join('\n')

const nastyIn = findMathRegions(nasty)
const nastyBadIn = nastyIn.filter((r) => rejects(r))
check('the control input has syntax katex rejects', nastyBadIn.length > 0, `${nastyBadIn.length} rejected region(s)`)

const nastyState = guard.createBlockState()
let nastyOut = ''
for (let i = 0; i < nasty.length; i += 5) nastyOut += nastyState.push(nasty.slice(i, i + 5))
nastyOut += nastyState.finish()

const nastyRegions = findMathRegions(nastyOut)
const nastyStillBad = nastyRegions.filter(rejects)
check('after repair no region is rejected in either framing', nastyStillBad.length === 0, `${nastyStillBad.length} still rejected`)
check('the repaired control still carries its conclusion', nastyOut.includes('0.3367'))
check('the repaired control keeps the heading text', nastyOut.includes('第 1 步：分解'))
check('the repaired control keeps the prose after the maths', nastyOut.includes('写出反射规则'))
console.log(`  control: ${nastyIn.length} region(s) -> ${nastyRegions.length} region(s), ${nastyStillBad.length} rejected after repair`)

console.log(`\n  reference output: ${ref.length} chars, ${findMathRegions(ref).length} math region(s)`)
console.log(`\n=== E2E RESULT: ${pass} passed, ${fail} failed ===`)
if (fail > 0) process.exitCode = 1
