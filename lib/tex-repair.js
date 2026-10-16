/**
 * Oracle-based math repair — parser-faithful regions, renderer-verified verdicts.
 *
 * WHY DETECTION IS NOT A REGEX
 *   A measured A/B run (`katex-ab.mjs`, 31 cases) showed the obvious heuristics are
 *   wrong in both directions: a 300-character formula, an 8-deep `\underbrace` chain,
 *   `\substack`, and Chinese inside maths all render fine, while a 99-character formula
 *   died. Length, brace depth and "heavy constructs" predict nothing, so detection asks
 *   the renderer instead of guessing.
 *
 * WHY REGIONS ARE CUT THE WAY THEY ARE
 *   Version 1 judged each `$$…$$` by the body BETWEEN the delimiters. It asked KaTeX a
 *   question the client never asks, and reported zero defects in genuinely broken text.
 *   Version 2 over-corrected and flagged every region, because its structural rules
 *   matched the delimiters it had included itself. Both mistakes came from guessing how
 *   delimiters pair.
 *
 *   The pairing rule is not a guess: it ships in `dsh-client-ui-primitives` as
 *   `createMathFlow`, a micromark syntax extension. Read out of the bundle, it says:
 *
 *     - `$$` opens a FLOW construct entered as `mathFlow` + `mathFlowFence`;
 *     - `afterDollarOpen` calls `nok` when a THIRD `$` follows, so `$$$` is not maths;
 *     - the construct continues across line endings, so a `$$` block may span lines;
 *     - closing is attempted with `tokenizeClosingFence`, the same fence shape.
 *
 *   A flow construct is only dispatched at a line prefix. So a `$$` in the middle of a
 *   paragraph cannot open a display block, and the delimiters pair one off from there —
 *   which is exactly the reported failure. This module mirrors that shape: `$$` is
 *   display maths only at a line start, and a region is judged by the WHOLE fenced text
 *   the renderer would receive.
 *
 * WHAT A REPAIR DOES
 *   It never deletes mathematics and never touches source the renderer accepted. A
 *   rejected region is released as a fenced block, or with its delimiters removed, so
 *   the reader sees the formula source — recoverable and copyable — instead of a red
 *   error span, and fenced content is not re-parsed as maths.
 *
 * @module tex-repair
 */

import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

/** The colour KaTeX paints an error in when `errorColor` is left at its default. */
export const ERROR_COLOR = '#cc0000'

/**
 * Oracle state. Resolved on first use rather than at import time, because the config
 * that says which KaTeX to load only exists once the plugin is applied.
 */
let katex = null
let katexVersion = null
let katexEntry = null
let loadError = null
let loadPromise = null
let options = { katexPath: '', macros: {}, hostDir: '' }

/**
 * Point the oracle at a specific renderer build and macro set.
 *
 * Called by the plugin during `apply`, before any text is judged. Kept separate from
 * {@link judge} so the module stays usable standalone (the test suite calls `judge` with
 * no plugin at all) while the plugin can pin the same build the client uses.
 *
 * @param {{ katexPath?: string, macros?: Record<string, string>, hostDir?: string }} next
 */
export function setOracleOptions(next = {}) {
  options = {
    katexPath: typeof next.katexPath === 'string' ? next.katexPath : '',
    macros: next.macros && typeof next.macros === 'object' ? next.macros : {},
    hostDir: typeof next.hostDir === 'string' ? next.hostDir : '',
  }
  loadPromise = null
  katex = null
  katexVersion = null
  katexEntry = null
  loadError = null
}

/**
 * The host profile's `node_modules`, used as an extra resolution root.
 *
 * @returns {string}
 */
function defaultHostDir() {
  const home = process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/.dsh`
  return `${home.replace(/[\\/]+$/, '')}/profiles/desktop`
}

/**
 * Candidate ways to reach the renderer, most specific first.
 *
 * The `require.resolve` candidates exist because of a measured failure: importing a
 * DIRECTORY (`import('file:///…/node_modules/katex')`) is not supported by the ESM loader,
 * and KaTeX 0.16.47 is ESM-first so `import('katex')` from a checkout does not reach the
 * profile either. Resolving the package entry the way Node itself would — with a
 * `createRequire` seeded at the directory in question — is what makes the oracle find the
 * same build the client renders with, without naming a file inside the package (which
 * would break on the next KaTeX release).
 *
 * @returns {string[]}
 */
function candidates() {
  const list = []
  const add = (value) => {
    if (value && !list.includes(value)) list.push(value)
  }
  if (options.katexPath) {
    // A configured path may be the package directory or its entry file.
    add(existsSync(`${options.katexPath.replace(/[\\/]+$/, '')}/package.json`) ? options.katexPath : options.katexPath)
  }
  for (const base of [options.hostDir, defaultHostDir()]) {
    if (!base) continue
    try {
      add(createRequire(`${base.replace(/[\\/]+$/, '')}/package.json`).resolve('katex'))
    } catch {
      /* the profile may not carry katex; the bare specifier below is the fallback */
    }
  }
  add('katex')
  return list
}

/**
 * Turn a candidate into something `import()` accepts.
 *
 * The drive-letter case is why this is not a one-line check: `C:\…\katex.js` looks like a
 * URL scheme (`C:`) to a naive test, so a Windows path was handed to `import()` unchanged
 * and rejected with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. A single-letter prefix followed by a
 * separator is a path, not a scheme.
 *
 * @param {string} candidate
 * @returns {string}
 */
function toSpecifier(candidate) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) return candidate // a real URL
  if (/^[a-zA-Z]:[\\/]/.test(candidate)) return pathToFileURL(candidate).href // a Windows path
  if (/^[\\/]/.test(candidate)) return pathToFileURL(candidate).href // a POSIX path
  return candidate // a bare specifier: let the resolver decide
}

/**
 * Load the renderer.
 *
 * Resolution order matters: a configured path wins, then the host profile's own resolution
 * (the shipped build, which is what the client renders with), then a plain `katex`
 * specifier for a consumer whose own tree carries it. Every failure is collected instead
 * of thrown — a plugin that cannot find KaTeX must still let the turn through, just
 * without repairs.
 *
 * `entry` is reported because a probe may want to load the very same build itself (the test
 * suite does, from the package root); it is the resolved specifier, so it is a file path or
 * URL rather than the configured value, and it stays null while the oracle is unavailable.
 *
 * @returns {Promise<{ available: boolean, version: string | null, entry: string | null, error: string | null }>}
 */
export async function loadOracle() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const attempts = []
    for (const candidate of candidates()) {
      try {
        const mod = await import(toSpecifier(candidate))
        const api = mod?.default ?? mod
        if (typeof api?.renderToString === 'function') {
          katex = api
          katexVersion = api.version ?? '(unknown)'
          katexEntry = candidate
          loadError = null
          return { available: true, version: katexVersion, entry: katexEntry, error: null }
        }
        attempts.push(`${candidate}: no renderToString`)
      } catch (err) {
        attempts.push(`${candidate}: ${err?.message ?? err}`)
      }
    }
    katex = null
    katexEntry = null
    loadError = new Error(`no usable katex found (${attempts.join('; ')})`)
    return { available: false, version: null, entry: null, error: loadError.message }
  })()
  return loadPromise
}

/**
 * What the oracle found, for a log line or a health check.
 *
 * @returns {Promise<{ available: boolean, version: string | null, entry: string | null, error: string | null }>}
 */
export async function oracleStatus() {
  return loadOracle()
}

/**
 * Truthy once the oracle could be loaded. Kept as a promise-shaped helper because loading
 * is asynchronous; `apply` awaits it so the synchronous stream path never has to.
 *
 * @returns {Promise<boolean>}
 */
export async function ensureOracle() {
  const status = await loadOracle()
  return status.available
}

/**
 * Snapshot of the oracle, for a diagnostic that cannot await. Call {@link loadOracle}
 * first; before that this reports "not loaded yet" rather than guessing.
 */
export function oracleSnapshot() {
  return { available: katex !== null, version: katexVersion, entry: katexEntry, error: loadError?.message ?? null }
}

/**
 * The renderer's error colour appearing in the output means the reader is looking at a
 * red blob, whatever the call did.
 *
 * WHY THIS IS A SEPARATE SIGNAL: an earlier version treated "the strict call succeeded"
 * as proof the region renders. It does not. Measured on the pinned KaTeX,
 * `\htmlClass{red}{x}` passes strict mode and still renders `\htmlClass` in `#cc0000`
 * (HTML extensions are disabled, so the command has no effect and the renderer falls
 * back to showing it). Judging by the output rather than by the absence of a throw is
 * the only way to catch that.
 *
 * @param {string} html
 */
export function rendersRed(html) {
  return typeof html === 'string' && html.includes(ERROR_COLOR)
}

/**
 * Ask the renderer what it thinks of one maths region — the same call the client makes.
 *
 * `html` is returned alongside the verdict because the caller has to tell a red render
 * from a clean one; `ok` alone cannot express that (see {@link rendersRed}).
 *
 * @param {string} tex
 * @param {boolean} displayMode
 * @returns {{ ok: boolean, html: string | null, red: boolean, position: number | null, message: string | null }}
 */
export function judge(tex, displayMode) {
  if (!katex) {
    const status = oracleSnapshot()
    return {
      ok: false,
      html: null,
      red: false,
      position: null,
      message: `oracle unavailable: ${status.error ?? 'not loaded yet (await loadOracle() first)'}`,
    }
  }
  const shared = { displayMode, macros: options.macros }
  let html = null
  try {
    html = katex.renderToString(tex, { ...shared, throwOnError: true })
  } catch (err) {
    // The product's second arm: `strict:'ignore'` plus `throwOnError:false`. It never
    // throws; on a parse error it returns html with the message in the error colour.
    try {
      html = katex.renderToString(tex, { ...shared, strict: 'ignore', throwOnError: false })
    } catch {
      html = null
    }
    const message = String(err?.message ?? err)
    const m = /at position (\d+)/.exec(message)
    return { ok: false, html, red: rendersRed(html), position: m ? Number(m[1]) : null, message }
  }
  return { ok: true, html, red: rendersRed(html), position: null, message: null }
}

/**
 * Recover the source text KaTeX echoed into an error span.
 *
 * Two accounts exist and they disagree by error CLASS, which matters before trusting
 * either. The html account reads the `<mtext>` annotation, and KaTeX only uses that
 * annotation for errors it can echo verbatim — an unknown command, say. A DOUBLE
 * SUBSCRIPT is echoed as assembled markup instead, so `echoedErrorText(html)` returns
 * null for `x_1_2` and recovery is skipped: that is why a recoverable doubled subscript
 * used to fall through to the fence. Measured on the pinned KaTeX:
 *
 *   `\foobar{x}` -> <mtext>\foobar</mtext>   -> "\foobar"
 *   `x_1_2`      -> spans, no <mtext>        -> null (message carries "x_1_̲2")
 *
 * The message account always carries the echo, but marks the failing character with
 * U+0332 COMBINING LOW LINE, so it is stripped before the text can be matched against
 * the source. Both accounts are tried; html first, because it is what the renderer
 * actually painted.
 *
 * @param {string} html
 * @param {string} [message] the caught error's message, when the caller has one
 * @returns {string | null}
 */
export function echoedErrorText(html, message) {
  if (typeof html === 'string') {
    const m = /<mtext[^>]*>([\s\S]*?)<\/mtext>/.exec(html)
    if (m) {
      const text = unescapeEntities(m[1])
      if (text.length > 0) return text
    }
  }
  if (typeof message !== 'string') return null
  const after = /at position \d+: ([\s\S]*)$/.exec(message)
  let quote = after ? after[1] : null
  if (quote === null) {
    const colon = message.indexOf(': ')
    if (colon < 0) return null
    quote = message.slice(colon + 2)
  }
  const text = quote.replace(/[\u0332\u0333]/g, '')
  return text.length > 0 ? text : null
}

/** The entities KaTeX escapes into an error span. */
function unescapeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
}

/**
 * The error message's account of the failure: the echoed text, the character it marked, and
 * where that echo sits in the echoed text.
 *
 * The message account is the ONLY one a doubled operator appears in (see
 * {@link echoedErrorText}), and it has two properties the repair has to respect:
 *
 *   - it marks the failing character with U+0332 COMBINING LOW LINE, which is what makes
 *     `position + 1` cells of the quote correspond to `position` cells of the input;
 *   - it is TRUNCATED at 32 characters with a `…`. Measured on the pinned KaTeX:
 *     `x_1_2 \;=\; x_{1_2}` is reported as `at position 4: x_1_̲2 \;=\; x_{1_2}` — the whole
 *     rest of the formula arrives as part of the echo. A repair that searched for that echo
 *     would match text the error never pointed at, which is how an earlier version turned
 *     `x_1_2 \;=\; x_{1_2}` into `x_{1_2 \;=\; x_{1_2}}`: a silently DIFFERENT formula.
 *     The caller therefore limits every rewrite to the marked position, and this function
 *     refuses an echo whose marked character falls outside the text it returned.
 *
 * @param {string} message
 * @returns {{ text: string, markedAt: number, relStart: number, relEnd: number } | null}
 */
function messageEcho(message) {
  if (typeof message !== 'string') return null
  const at = /at position (\d+): ([\s\S]*)$/.exec(message)
  let quote = at ? at[2] : null
  if (quote === null) {
    const colon = message.indexOf(': ')
    if (colon < 0) return null
    quote = message.slice(colon + 2)
  }
  const dot = quote.indexOf('…')
  if (dot >= 0) quote = quote.slice(0, dot)

  const markIndex = quote.search(/[\u0332\u0333]/)
  const text = quote.replace(/[\u0332\u0333]/g, '')
  if (text.length === 0) return null
  // The mark sits AFTER the character it underlines, so in the stripped text that character is
  // one to the left (`x_1_̲2` underlines the second `_`, index 3). Everything before it keeps
  // its index, which is what makes `markedAt` a usable position in the stripped text.
  const rawAt = at ? Number(at[1]) : -1
  const markedAt = markIndex >= 0 ? markIndex - 1 : rawAt
  if (markedAt >= text.length) return null

  // The echo's own extent is NOT a rewrite window. `a_1_2 + b_3_4 = c` is quoted in full, and
  // `x_1_2 \;=\; x_{1_2}` is quoted in full too: rewriting everything from the echo's first cell
  // to its last turned the second case into a different formula. What IS exact is the mark —
  // `markedAt` names the character the renderer refused, in the very text the caller passed in —
  // so the window is declared as that single character. `end` still carries the echo's length,
  // which is how the caller distinguishes a bounded echo from one that covers the whole input.
  const relStart = markedAt > 0 ? markedAt : 0
  const relEnd = markedAt >= 0 ? text.length : 0
  return { text, markedAt, relStart, relEnd }
}

/**
 * The error's echo, plus the slice of the input the error actually pointed at.
 *
 * The slice is the point of this wrapper: recovery may only rewrite the token the renderer
 * complained about, never the rest of the region. A truncated echo is therefore still usable —
 * its marked position is exact — while a full-length echo with no mark is only trustworthy when
 * it is literally the whole input, because anything shorter may be a prefix the message cut off.
 *
 * @param {string} html
 * @param {string} message
 * @param {string} source the region body the renderer was given
 * @returns {{ echo: string, start: number, end: number, mark: number } | null}
 */
export function errorEcho(html, message, source) {
  const src = typeof source === 'string' ? source : ''
  // An undefined control sequence is the one error the message names outright, and its quotes are
  // underlined WHOLE (`\foobar{x}` arrives as `\̲f̲o̲o̲b̲a̲r̲{x}`), so a mark-anchored read of that
  // message returns the entire region as the echo — which is a position, not a token, and made
  // every unknown command unrecoverable. The named command is the token: prefer it.
  const named = typeof message === 'string' ? /Undefined control sequence: (\\[A-Za-z@]+)/.exec(message) : null
  if (named !== null && src.includes(named[1])) {
    const found = src.indexOf(named[1])
    return { echo: named[1], start: found, end: found + named[1].length, mark: found }
  }
  if (typeof message === 'string') {
    const parsed = messageEcho(message)
    if (parsed !== null && (parsed.markedAt >= 0 || parsed.text === src)) {
      const found = src.indexOf(parsed.text)
      if (found >= 0) {
        const from = found + parsed.relStart
        const to = found + parsed.relEnd
        // `mark` is the ONE position the message vouched for. A caller that rewrites text must
        // stay inside the token around it; `start`/`end` describe the echo and are not a licence.
        return {
          echo: parsed.text,
          start: Math.max(0, from),
          end: Math.max(from, to),
          mark: parsed.markedAt >= 0 ? found + parsed.markedAt : -1,
        }
      }
    }
  }
  // A red-render (the strict pass succeeded and KaTeX painted the source `#cc0000`) reports NO
  // message at all, so the message account is closed for it — `errorEcho(html, null, …)` used to
  // return null and every such region fell through to the fence, which then cut table rows in
  // half. The painted span is the echo, and it names the command to strip.
  if (typeof message !== 'string' || message === '') {
    const painted = /style="color:#cc0000[^"]*"[^>]*>((?:\\[A-Za-z@]+)+)</.exec(html || '')
    if (painted !== null && src.includes(painted[1])) {
      const found = src.indexOf(painted[1])
      return { echo: painted[1], start: found, end: found + painted[1].length, mark: found }
    }
  }
  const echo = echoedErrorText(html, message)
  if (echo === null) return null
  // The html account has no position, so a fragment cannot be located with confidence: only an
  // echo that IS the input is safe to act on.
  if (src !== '' && echo !== src) return null
  const found = src.indexOf(echo)
  return { echo, start: Math.max(0, found), end: found < 0 ? 0 : found + echo.length, mark: -1 }
}

/**
 * True when only spaces/tabs precede this offset on its line.
 * A flow construct is dispatched at a line prefix, so this decides display vs inline.
 *
 * @param {string} text
 * @param {number} i
 */
function atLineStart(text, i) {
  for (let j = i - 1; j >= 0; j -= 1) {
    const c = text[j]
    if (c === '\n') return true
    if (c !== ' ' && c !== '\t' && c !== '\r') return false
  }
  return true
}

/**
 * The end of an inline code span that starts at `i`, or -1 when `i` is not a code span.
 *
 * A span is opened by a run of N backticks and closed by the next run of exactly N on the
 * same line (GFM: a code span that is not closed on its line is not a code span at all, which
 * is why `text.indexOf('\\n')` is part of the answer and not a detail).
 *
 * WHY THE SCANNER NEEDS THIS. Inline code is literal: the reader sees `` `$1,` `` as the four
 * characters someone typed, and a `$` in there is not a delimiter any more than a `$` inside a
 * fence is. Measured on real transcripts — this is how `` `$1,` `` in a PowerShell example came
 * out as `` `1,` `` on screen: the scanner read the `$` as an unterminated inline region and the
 * repair removed it, editing the user's code sample. A second, quieter failure rides along: an
 * unterminated `$` opened OUTSIDE code would happily be closed by a `$` INSIDE a code span, so
 * the region's body — and therefore the verdict and the repair — was decided by text that is
 * inert.
 *
 * @param {string} text
 * @param {number} i index of the first backtick
 * @returns {number} index just past the closing run, or -1
 */
function codeSpanEnd(text, i) {
  const n = text.length
  let run = 0
  while (i + run < n && text[i + run] === '`') run += 1
  const token = '`'.repeat(run)
  let j = i + run
  while (j < n) {
    if (text[j] === '\n') return -1
    if (text[j] === '`') {
      let close = 0
      while (j + close < n && text[j + close] === '`') close += 1
      if (close === run) return j + close
      j += close
      continue
    }
    j += 1
  }
  return -1
}

/**
 * Find maths regions the way the shipped tokenizer does.
 *
 * Display: `$$` at a line start (not `$$$`), closed by the next `$$`, spanning lines.
 * Inline: a single `$` not escaped, closed by the next `$`.
 *
 * Fenced code (three or more backticks or tildes at a line start) and inline code spans are
 * literal and skipped — see {@link codeSpanEnd} for the measurement that made inline code a
 * requirement rather than a nicety.
 *
 * @param {string} text
 * @returns {Array<{ kind: 'display' | 'inline', start: number, end: number, raw: string, body: string, delimiter: string, unterminated: boolean, midLineDisplay: boolean }>}
 */
export function findMathRegions(text) {
  const regions = []
  const n = text.length
  let i = 0
  let fence = null
  while (i < n) {
    // Fenced code is literal: `$` inside it must never be read as a delimiter. A repair
    // emits fences, so a fence-blind scanner would re-scan its own output and find new
    // "regions" in text that is inert (this actually happened — a repaired block
    // produced an unterminated region in a test).
    if (atLineStart(text, i) && (text[i] === '`' || text[i] === '~')) {
      const marker = text[i]
      let run = 0
      while (i + run < n && text[i + run] === marker) run += 1
      if (run >= 3) {
        const token = marker.repeat(run)
        const lineEnd = text.indexOf('\n', i)
        const rest = lineEnd < 0 ? text.slice(i) : text.slice(i, lineEnd)
        if (fence === null) {
          fence = { token, marker }
        } else if (marker === fence.marker && run >= fence.token.length && rest.trim() === token) {
          fence = null
        }
        i = lineEnd < 0 ? n : lineEnd + 1
        continue
      }
    }
    if (fence !== null) {
      const lineEnd = text.indexOf('\n', i)
      i = lineEnd < 0 ? n : lineEnd + 1
      continue
    }
    // Inline code, the fence's single-line sibling. Checked before the `$` branch: a span that
    // starts at or before the dollar makes that dollar literal, while a `$` that opens first
    // is untouched by this branch and still starts a region.
    if (text[i] === '`') {
      const spanEnd = codeSpanEnd(text, i)
      if (spanEnd >= 0) {
        i = spanEnd
        continue
      }
    }
    if (text[i] !== '$' || (i > 0 && text[i - 1] === '\\')) {
      i += 1
      continue
    }
    const isDD = text.startsWith('$$', i) && !text.startsWith('$$$', i)
    const display = isDD && atLineStart(text, i)
    /** A `$$` that pairs correctly but sits mid-paragraph: display intent, inline parsing. */
    const midLineDisplay = isDD && !display
    const delim = isDD ? '$$' : '$'
    const bodyStart = i + delim.length

    let j = bodyStart
    let close = -1
    while (j < n) {
      if (text[j] === '\\') {
        j += 2
        continue
      }
      if (!display && !midLineDisplay && text[j] === '\n') break // inline maths never spans a line
      if (text.startsWith(delim, j)) {
        close = j
        break
      }
      j += 1
    }
    const end = close < 0 ? n : close + delim.length
    regions.push({
      kind: display ? 'display' : 'inline',
      start: i,
      end,
      raw: text.slice(i, end),
      delimiter: delim,
      body: close < 0 ? text.slice(bodyStart) : text.slice(bodyStart, close),
      unterminated: close < 0,
      midLineDisplay,
    })
    i = end
  }
  return regions
}

/**
 * Try to make a region render without the error colour, using the renderer's own echo
 * of the problem as the handle.
 *
 * Only TWO moves are allowed, both of which keep the reader's content visible:
 *   - a command the renderer does not know (`\foobar`, or `\htmlClass` when extensions
 *     are disabled) loses its backslash, so the reader sees `foobar` instead of a red
 *     `\foobar`;
 *   - an operator that got doubled (`x_1_2`) keeps its first argument and takes the
 *     rest as a group (`x_{1_2}`).
 * Anything else is left alone: guessing at structural damage is how a repair invents
 * mathematics the author never wrote. The caller degrades those to a fenced source
 * block, where the reader still sees the original text.
 *
 * Each candidate is re-rendered and accepted only if the red is gone AND the strict
 * call now succeeds. That double condition is why this cannot loop forever on a change
 * that merely moves the error: a candidate that is still red is discarded.
 *
 * @param {string} body
 * @param {boolean} displayMode
 * @returns {{ ok: boolean, body: string, moves: string[] }}
 */
export function recoverRedRegion(body, displayMode) {
  let current = body
  const moves = []
  const MAX_MOVES = 8
  for (let i = 0; i < MAX_MOVES; i += 1) {
    const verdict = judge(current, displayMode)
    if (verdict.ok && !verdict.red) return { ok: true, body: current, moves }

    const found = errorEcho(verdict.html, verdict.message, current)
    if (found === null) return { ok: false, body, moves: [] }
    const { echo, start, end, mark } = found

    // Candidate repairs are validated, never trusted: a candidate that is still red, or
    // that only moves the error, is discarded rather than shipped (see the module note).
    const candidates = []
    // A control sequence the renderer cannot use. Longest-name-first is not needed:
    // KaTeX names exactly one command per error.
    if (/^\\[A-Za-z@]+$/.test(echo) && current.includes(echo)) {
      candidates.push({ text: current.split(echo).join(echo.slice(1)), move: `command ${echo} -> ${echo.slice(1)}` })
    } else if (/^_/.test(current.slice(mark, mark + 1)) || mark < 0) {
      // `x_1_2`: a second `_` on a subscript that already exists, so what follows it becomes a
      // group. The rewrite is bounded by the TOKEN around the marked character, never by the
      // echo: KaTeX quotes the whole formula (`a_1_2 + b_3_4 = c`) and a long quote is cut off
      // with an ellipsis, and regrouping an echo-sized span once turned `x_1_2 \;=\; x_{1_2}`
      // into a different formula. Characters that end a TeX token are the delimiters, operands
      // and separators; everything else is walked over. When the renderer named no position
      // (the html-only account), every token is offered as a candidate instead of none.
      //
      // Deliberately ONE level only — `x_1_2_3` needs a second pass, which the loop above
      // provides by re-judging whatever was chosen, and each pass is validated before it ships.
      const boundaries = new Set(['{', '}', '(', ')', '[', ']', '|', '+', '-', '=', '<', '>', ',', ';', ':', ' ', '\t', '\n', '\\', '^', '&'])
      // The marked anchor first, then every other doubled subscript in the region. The others
      // are a fallback, not an equal: a region can carry several (`a_1_2 + b_3_4 = c` reports
      // one error per token, one at a time), and the first repair is rejected by the re-judge
      // whenever another one remains. Without the fallback the region degrades to visible
      // source even though every token in it was recoverable.
      // Every doubled subscript in the region is regrouped in ONE rewrite, and each individual
      // one is also offered alone. Both are needed: a region can carry several of them
      // (`a_1_2 + b_3_4 = c`), and because every candidate is re-judged before it is accepted,
      // a one-at-a-time repair for that body is rejected — the other token is still red — so
      // offering only single rewrites degraded the whole region to visible source even though
      // every token in it was recoverable.
      //
      // A subscript `_` inside a group (`a_{1_2}`) is left alone: it is valid TeX, and
      // regrouping it produced `a_{1_{2_3}}`, which renders but no longer says what the
      // author wrote. Each rewrite is validated by the judge like any other candidate, so a
      // wrong grouping is discarded rather than shipped.
      const inGroup = (text, at) => {
        let depth = 0
        for (let i = 0; i < at; i += 1) {
          if (text[i] === '\\') { i += 1; continue }
          if (text[i] === '{') depth += 1
          else if (text[i] === '}') depth -= 1
        }
        return depth > 0
      }
      // Every doubled subscript in the region is regrouped by ONE rewrite, and each one is also
      // offered alone. Both are needed: a region can carry several (`a_1_2 + b_3_4 = c`), and
      // because every candidate is re-judged before it is accepted, a one-at-a-time repair of
      // that body is rejected — the other token is still red — so offering only single rewrites
      // degraded the whole region to visible source even though every token in it was
      // recoverable. The combined form is tried first, so the fewest moves win.
      //
      // The rewrite is built from the ORIGINAL text in one pass, right to left. Applying a
      // repair and then re-deriving the next span from the repaired text is what broke this
      // before: the new braces shift every index, and the second rewrite then spanned
      // `a_{1_2} + b_3_4` as if it were one token.
      //
      // A subscript inside a group is left alone: `_` is a valid subscript there (`a_{1_2}`),
      // and regrouping a braced one turned `x_{1_2}_3` into `x_{1_{2_3}}` — it renders, but it
      // says something else. Only an UNBRACED doubled subscript is a TeX error, and only the
      // rewrite of that is offered.
      const doubledSpans = () => {
        const spans = []
        const re = /([A-Za-z0-9}])((?:_[^_{}\s])+)/g
        let m
        while ((m = re.exec(current)) !== null) {
          const ops = m[2]
          if ((ops.match(/_/g) || []).length < 2) continue
          if (inGroup(current, m.index + m[1].length)) continue
          const cut = ops.lastIndexOf('_')
          const inner = ops.slice(1, cut)
          const outer = ops.slice(cut + 1)
          if (inner.length < 1 || outer.length === 0) continue
          if (current[m.index + m[0].length] === '{') continue
          spans.push({ from: m.index, to: m.index + m[0].length, head: m[1], inner, outer })
        }
        return spans
      }
      const groupSpans = (spans) => {
        let out = current
        let shift = 0
        for (const span of spans) {
          const from = span.from + shift
          const to = span.to + shift
          const fix = `${span.head}_{${span.inner}_${span.outer}}`
          out = out.slice(0, from) + fix + out.slice(to)
          shift += fix.length - (span.to - span.from)
        }
        return out
      }
      const spans = doubledSpans()
      if (spans.length > 0) {
        const allAtOnce = groupSpans(spans)
        if (allAtOnce !== current) candidates.push({ text: allAtOnce, move: 'double subscript -> grouped subscript' })
        for (const span of spans) candidates.push({ text: groupSpans([span]), move: 'double subscript -> grouped subscript' })
      }
    }
    let chosen = null
    for (const candidate of candidates) {
      if (candidate.text === current) continue
      const check = judge(candidate.text, displayMode)
      if (check.ok && !check.red) {
        chosen = candidate
        break
      }
    }
    if (chosen === null) return { ok: false, body, moves: [] }
    moves.push(chosen.move)
    current = chosen.text
  }
  return { ok: false, body, moves: [] }
}

/**
 * Faults that suggest delimiters paired wrongly. Each rule is applied to the region BODY
 * only — never to the delimiters, which are the region's own framing and would otherwise
 * match every rule (the version-2 false positive).
 *
 * These are SYMPTOMS, not verdicts. See {@link releasesCleanly}.
 */
const STRUCTURAL_RULES = [
  { id: 'heading-inside', re: /(^|\n)[ \t]{0,3}#{1,6}[ \t]/, why: 'a Markdown heading was swallowed into the maths' },
  { id: 'list-inside', re: /(^|\n)[ \t]{0,3}([-*+]|\d+\.)[ \t]+\S/, why: 'a Markdown list item was swallowed into the maths' },
  { id: 'blank-line-inside', re: /\n[ \t]*\n/, why: 'a blank line ends the paragraph, so this cannot be one formula' },
  { id: 'delimiter-inside', re: /(?<!\\)\$\$?/, why: 'a maths delimiter is left inside the region, so pairing is off by one' },
]

/**
 * Would the region render if it were re-framed the way {@link releaseRegion} re-frames it?
 *
 * WHY THIS EXISTS — a measured false positive that reached a real transcript. Structural rules
 * were treated as verdicts, so a region whose delimiter pairing looks odd was flagged and
 * "repaired" even when the renderer accepted it. `$$\text{$\alpha$ 是闭 1-形式}$$` is the case:
 * the pairing heuristic starts a new region at the `$` inside `\text{…}`, so the first region
 * ends there and the rest looks like damage — but KaTeX renders `\text{$\alpha$ …}` without
 * complaint, and the reader saw a perfectly good formula. Worse, the re-framing then split the
 * text so that a *new* region opened around the second `$` and ran on, so the "repair" made the
 * verdict worse rather than better.
 *
 * So the renderer keeps the last word: a pattern match is only actionable when the released
 * form would still be rejected. This mirrors what {@link releaseRegion} itself checks — it
 * re-frames a display region only when the body renders cleanly — so the verdict and the
 * repair now agree by construction instead of by coincidence.
 *
 * @param {{kind: string, body: string, midLineDisplay?: boolean}} region
 * @returns {boolean} true when the re-framed region renders with no error colour
 */
function releasesCleanly(region) {
  if (!katex) return true // no renderer: no structural verdict either
  const displayMode = region.kind === 'display' || Boolean(region.midLineDisplay)
  const asIs = judge(region.body, displayMode)
  if (displayMode && asIs.ok && !asIs.red) return true
  return recoverRedRegion(region.body, displayMode).ok
}

/**
 * The TeX the renderer actually hands to KaTeX: the region body, delimiters removed.
 *
 * This is the single most error-prone detail in the whole module. Every wrong version
 * got it wrong in a different way — judging only the body (missed the pairing fault),
 * judging the raw region including `$$` (flagged every valid formula, because KaTeX has
 * no idea what a Markdown delimiter is), and applying structural rules to the raw region
 * (matched its own framing). So it lives in exactly one place, and the guard test
 * asserts that a valid formula survives untouched.
 *
 * @param {{body: string}} region
 * @returns {string}
 */
export function texOf(region) {
  return region.body
}

/**
 * Decide whether one region must be repaired, and why.
 *
 * @param {{kind: string, body: string, raw: string, unterminated?: boolean, delimiter?: string, midLineDisplay?: boolean}} region
 * @returns {{ verdict: 'ok' | 'repair', reason: string | null, detail: string | null }}
 */
export function inspect(region) {
  if (!katex) {
    // No renderer, no verdict. Reporting "repair" here would be a guess, and a guess that
    // fences every formula in the answer — far worse than the defect being prevented. The
    // plugin awaits {@link loadOracle} during `apply`, so this is a fallback, not the norm.
    return { verdict: 'ok', reason: null, detail: 'oracle unavailable' }
  }
  if (region.unterminated) {
    return { verdict: 'repair', reason: 'unterminated', detail: 'the region has no closing delimiter' }
  }
  for (const rule of STRUCTURAL_RULES) {
    const m = rule.re.exec(region.body)
    if (m) {
      // The pattern is only a reason to act if the re-framed form would still fail.
      if (releasesCleanly(region)) {
        return { verdict: 'ok', reason: null, detail: `${rule.id} pattern seen but the renderer accepts it` }
      }
      return { verdict: 'repair', reason: rule.id, detail: `${rule.why} (matched ${JSON.stringify(m[0].slice(0, 24))})` }
    }
  }
  if (region.midLineDisplay) {
    // The delimiters pair, but they pair as INLINE maths, so KaTeX receives the
    // delimiters as part of the TeX and rejects them. Judge the body as the author
    // intended it (display) to decide whether it can be re-framed.
    const asDisplay = judge(region.body, true)
    return asDisplay.ok && !asDisplay.red
      ? { verdict: 'repair', reason: 'mid-paragraph-display', detail: 'a display block was opened mid-paragraph, so the delimiters did not pair as display maths' }
      : { verdict: 'repair', reason: 'oracle-rejected', detail: asDisplay.message }
  }
  const displayMode = region.kind === 'display'
  const verdict = judge(texOf(region), displayMode)
  if (!verdict.ok) {
    return { verdict: 'repair', reason: 'oracle-rejected', detail: verdict.message }
  }
  if (verdict.red) {
    // The strict call succeeded and the reader is STILL looking at a red blob: the
    // renderer drew its own error message into the output. This is the case an
    // "did it throw?" oracle reports as fine, so it is checked separately.
    return {
      verdict: 'repair',
      reason: 'red-render',
      detail: `the renderer painted the error colour: ${JSON.stringify(echoedErrorText(verdict.html) ?? '')}`,
    }
  }
  return { verdict: 'ok', reason: null, detail: null }
}

/**
 * Release a region as text the renderer will not paint red.
 *
 * Order matters, and every step keeps the mathematics rather than deleting it:
 *   1. a region whose only problem was framing is re-framed and rendered normally;
 *   2. a region the renderer can be talked out of failing (unknown command, doubled
 *      operator) is repaired and rendered, with the substitution visible in the maths;
 *   3. everything else is fenced as source, so the reader still sees the formula.
 *
 * An unterminated region has no real body to fence, so its own text is emitted as-is —
 * fencing it would invent a boundary the renderer never saw.
 *
 * @param {{body: string, kind?: string, unterminated?: boolean, midLineDisplay?: boolean, delimiter?: string}} region
 * @returns {string}
 */
/**
 * What sits to the left of the region on a line, when that is a quote marker.
 *
 * A region that lives inside a blockquote cannot be re-framed from column 0: the frame is
 * emitted as plain lines, and a plain line ENDS the quote. Measured on a real transcript —
 * `> $$P(\xi=k)=…$$` came out as a quote broken into three pieces, `> \n\n$$\n…\n$$\n\n\n>`,
 * because the replacement dropped the `>` that made it a quote in the first place.
 *
 * Only `>` is returned. A list marker or a fence indentation would need the same treatment,
 * but neither has been observed inside a maths region, and guessing here would change text
 * that is currently correct.
 *
 * @param {string} raw the region's source text, delimiters included
 * @returns {string} the line prefix to carry into the replacement, or ''
 */
function quotePrefix(raw) {
  const first = /^([ \t]*(?:>[ \t]?)+)/.exec(raw)
  if (!first) return ''
  const prefix = first[1]
  const lines = raw.split('\n').slice(1).filter((line) => line.trim() !== '')
  if (lines.length > 0 && !lines.every((line) => line.startsWith(prefix.trimEnd()))) return ''
  return prefix
}

/**
 * Turn a maths region into the text that replaces it.
 *
 * Every exit is a DIFFERENT kind of degradation, in order of preference: a valid region keeps
 * its rendered formula, a recoverable one keeps a repaired formula, and only an unrecoverable
 * one shows its source. The frame is a multi-line construct, so it is written with the
 * surrounding line structure in mind: {@link quotePrefix} keeps a blockquote a blockquote.
 *
 * @param {{ kind: string, raw: string, body: string, delimiter: string, unterminated: boolean, midLineDisplay?: boolean }} region
 * @returns {string}
 */
export function releaseRegion(region) {
  const body = region.body.replace(/^\n+|\n+$/g, '')
  // An unterminated INLINE region is just a stray `$` in prose; emitting its body is the
  // whole repair. An unterminated DISPLAY region still has a delimiter that would
  // re-enter maths, so its body is fenced to stop that from happening.
  if (region.unterminated && region.delimiter !== '$$') return region.body

  const displayMode = region.kind === 'display' || Boolean(region.midLineDisplay)
  const quote = quotePrefix(region.raw)
  /** A display frame on its own lines, indented to stay where the region was. */
  const display = (tex) => (quote
    ? `\n${quote}\n${quote}$$\n${tex.split('\n').map((line) => (line === '' ? '' : quote + line)).join('\n')}\n${quote}$$\n`
    : `\n\n$$\n${tex}\n$$\n\n`)
  if (!katex) return region.body // no renderer: leave the text exactly as it arrived
  const asIs = judge(body, displayMode)
  if (displayMode && asIs.ok && !asIs.red) {
    // The mathematics is valid; only its framing was wrong. Re-frame it as a proper
    // display block instead of degrading it to source, so the reader keeps the rendered
    // formula.
    return display(body)
  }

  const recovered = recoverRedRegion(body, displayMode)
  if (recovered.ok) {
    // The repaired TeX is re-framed exactly like a healthy region, so the reader sees a
    // rendered formula rather than a red span.
    return region.kind === 'display' || region.midLineDisplay
      ? display(recovered.body)
      : `$${recovered.body}$`
  }

  if (region.kind === 'inline' && !region.midLineDisplay) {
    // A fenced block is a MULTI-LINE construct, so it cannot be the replacement for an
    // inline region: doing that once carved a table row into three pieces (the fence
    // ended the row, and the rest of the row was re-parsed as prose). Inline context
    // gets an inline fallback — the formula source with its delimiters removed, which
    // is plain visible text and leaves the surrounding line structure exactly as it was.
    return body
  }

  // Four backticks, not three: inside a quote the fence carries the quote's own prefix, and a
  // stray three-backtick run in the body would otherwise close it early.
  const fence = (tex) => (quote
    ? `\n${quote}\n${quote}\`\`\`\`\n${tex.split('\n').map((line) => (line === '' ? '' : quote + line)).join('\n')}\n${quote}\`\`\`\`\n`
    : `\n\n\`\`\`\n${tex}\n\`\`\`\n\n`)
  return fence(body)
}

/**
 * Repair every math region in a text fragment.
 *
 * Pure and synchronous on purpose: it is called from a stream transform, where a throw
 * would damage a real turn. It never throws — any internal failure returns the input
 * unchanged, because passing text through is always safer than blocking it.
 *
 * @param {string} text
 * @returns {{ text: string, repairs: Array<{ kind: string, reason: string | null, detail: string | null, before: string, after: string }> }}
 */
export function repairText(text) {
  const repairs = []
  try {
    if (typeof text !== 'string' || text === '' || !text.includes('$')) {
      return { text: typeof text === 'string' ? text : '', repairs }
    }
    const regions = findMathRegions(text)
    if (regions.length === 0) return { text, repairs }

    let out = ''
    let cursor = 0
    let touched = false
    for (const region of regions) {
      const { verdict, reason, detail } = inspect(region)
      if (verdict === 'ok') continue
      const replacement = releaseRegion(region)
      repairs.push({
        kind: region.kind,
        reason,
        detail,
        before: text.slice(region.start, Math.min(region.end, region.start + 120)),
        after: replacement.trim().slice(0, 120),
      })
      out += text.slice(cursor, region.start) + replacement
      cursor = region.end
      touched = true
    }
    if (!touched) return { text, repairs }
    out += text.slice(cursor)
    return { text: out, repairs }
  } catch (err) {
    return { text, repairs: [{ kind: 'internal', reason: 'error', detail: String(err?.message ?? err), before: '', after: '' }] }
  }
}

/**
 * Would the renderer paint any of this red, and can it be repaired?
 *
 * A convenience wrapper for a health check: it reports the verdict without producing
 * replacement text, so a diagnostic can quote the reason a region was flagged.
 *
 * @param {string} text
 * @returns {{ regions: number, flagged: Array<{ kind: string, reason: string | null, detail: string | null, before: string }> }}
 */
export function inspectText(text) {
  const flagged = []
  let regions = 0
  try {
    if (typeof text !== 'string' || !text.includes('$')) return { regions, flagged }
    const found = findMathRegions(text)
    regions = found.length
    for (const region of found) {
      const { verdict, reason, detail } = inspect(region)
      if (verdict === 'ok') continue
      flagged.push({
        kind: region.kind,
        reason,
        detail,
        before: text.slice(region.start, Math.min(region.end, region.start + 120)),
      })
    }
  } catch {
    /* a diagnostic never throws */
  }
  return { regions, flagged }
}
