// What does each tier of the product's chain actually LOOK like, and which tool
// produces it?
//
// Purpose: the guard was designed around a claim that tier 2 renders a formula with
// the offending part silently missing — "wrong but invisible". The rendered HTML has
// to be read to know whether that is true, and an earlier `tier` label was derived
// from whether a call returned htmlOrder, not from what the html contains. This probe
// separates the two questions and prints the visible text of each result.
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/<user>/.dsh/profiles/desktop/package.json')
const katex = require('katex')

const cases = [
  ['unknown command', '\\foobar{x}'],
  ['unknown command (no args)', 'x = \\notacommand'],
  ['unclosed brace', '\\frac{1}{2'],
  ['double subscript', 'x_1_2'],
  ['legal', '\\frac{1}{2}'],
  ['legal CJK text', '\\text{右行波}'],
  ['unicode math, strict', 'u = φ(x)'],
  ['strict-mode warning candidate', '\\text{a  b}'],
  ['trust-gated command', '\\htmlClass{red}{x}'],
  ['\\includegraphics (trust-gated)', '\\includegraphics{a.png}'],
]

/** Visible text of a katex result: MathML <mtext> plus the HTML-side text nodes. */
function visibleText(html) {
  const mtexts = [...html.matchAll(/<mtext[^>]*>([\s\S]*?)<\/mtext>/g)].map((m) => m[1])
  const spans = [...html.matchAll(/>([^<>]+)</g)].map((m) => m[1]).filter((s) => s.trim() && !/^(katex|math|semantics|mrow|mi|mo|mn|msup|msub|mfrac|mstyle|annotation|span)$/.test(s.trim()))
  return { mtext: mtexts.slice(0, 3), textNodes: spans.slice(0, 6) }
}

function describe(label, tex) {
  console.log(`\n[${label}] ${JSON.stringify(tex)}`)
  let strictHtml = null
  let strictErr = null
  try {
    strictHtml = katex.renderToString(tex, { displayMode: true, throwOnError: true })
  } catch (err) {
    strictErr = String(err.message ?? err)
  }
  if (strictErr) console.log(`  strict threw:   ${strictErr}`)
  else console.log('  strict:         ok')

  // The product's second arm.
  let lenientHtml = null
  let lenientErr = null
  try {
    lenientHtml = katex.renderToString(tex, { displayMode: true, strict: 'ignore', throwOnError: false })
  } catch (err) {
    lenientErr = String(err.message ?? err)
  }

  const html = strictHtml ?? lenientHtml
  if (lenientErr) {
    console.log(`  lenient threw:  ${lenientErr}`)
  } else if (html) {
    const red = /#cc0000/.test(html)
    const vis = visibleText(html)
    console.log(`  lenient:        ${strictHtml ? '(not used)' : `rendered${red ? ' WITH #cc0000 error colour' : ' with no error colour'}`}`)
    console.log(`     visible mtext:  ${JSON.stringify(vis.mtext)}`)
    console.log(`     visible text:   ${JSON.stringify(vis.textNodes)}`)
  }
}

console.log('=== per-tier visible output ===')
for (const [label, tex] of cases) describe(label, tex)

// Is the product's tier 2 reachable at all, and what does it look like when it is?
console.log('\n\n=== does `throwOnError:false` still emit htmlOrder? ===')
for (const [, tex] of cases) {
  let html = null
  let err = null
  try {
    html = katex.renderToString(tex, { displayMode: true, strict: 'ignore', throwOnError: false })
  } catch (e) {
    err = String(e.message ?? e)
  }
  const tag = err ? 'THREW' : /#cc0000/.test(html) ? 'html WITH #cc0000  <-- red error span, not a silent wrong render' : 'html, no error colour'
  console.log(`  ${tag}  ${JSON.stringify(tex.slice(0, 34))}`)
}
