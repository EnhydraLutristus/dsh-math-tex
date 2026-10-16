/**
 * dsh-math-tex — the stream guard (host half).
 *
 * Two independent defences, registered together because they fail differently:
 *
 *   1. `systemPrompt.section` — PRE-EMPTIVE rules, so the model stops producing glued
 *      headings and prose inside a `$$` block in the first place.
 *   2. `llm/stream` waterfall — the BACKSTOP. It rewrites the assistant's text after the
 *      model produces it and before it is persisted, so a region that would have
 *      rendered as the red source-dump is repaired instead.
 *
 * Defence 2 is why this plugin exists at all: the frontend is one monolithic bundle
 * inside `app.asar` and passes no KaTeX options (no `errorColor`, no `maxExpand`, no
 * `trust`), so the client cannot be configured after the fact. The stream is the last
 * place the text is still ours.
 *
 * THE RELEASE RULE
 *
 * Deltas arrive in arbitrary pieces, but a repair decision needs a whole region:
 * repairing `$E=mc^2` in isolation is not a prefix of repairing
 * `$E=mc^2=9\times10^{16}$`, because KaTeX parses the first as maths that never closed.
 * So the guard holds text until it can prove it will not change, and the proof is the
 * plugin's central invariant:
 *
 *     the text emitted so far is always a prefix of `repairText(whole answer)`
 *
 * It holds because the safety cut and the repairer share ONE region model — region
 * scanning is not re-implemented here, it is imported from `./tex-repair.js`. Text may
 * be released up to the start of the first region that has no closing delimiter yet, and
 * repairing that prefix's complete regions concatenates to the same string as repairing
 * the whole, including the separators a re-framing repair inserts in the gaps, because
 * those belong to the gaps rather than to the text already sent. A partial region is the
 * only thing that must wait, and it waits bounded: past `maxHold` the text is released
 * unrepaired rather than stalling, which is exactly the unguarded behaviour and
 * therefore safe.
 *
 * `test/wire-test.mjs` asserts that invariant directly, under one-character-per-delta
 * splitting, for nine documents including the real incident.
 *
 * @module guard
 */

import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repairText, findMathRegions, setOracleOptions, loadOracle } from './tex-repair.js'
import { resolveConfig } from './config.js'
import {
  TOKEN,
  PROMPT_RULES,
  createSessionMath,
  requestHasMath,
  sectionText,
  judgedWithoutSession,
} from './prompt-rules.js'

/**
 * Completion marker the prompt asks the model to emit after its last line of prose.
 *
 * It is a receipt, not a terminator: it proves the formatting rules were applied, and
 * the answer continues after it. The guard removes the marker wherever it appears and
 * keeps releasing text normally — an earlier version treated it as "the answer ends
 * here" and held everything after it until the turn ended.
 *
 * A guard loaded without the prompt rules still strips this marker, so a model that was
 * told about it by an older prompt cannot leak it into an answer.
 *
 * The value lives in {@link ./prompt-rules.js} beside the rules that ask for it, and is
 * re-exported here because this module is what the entry point and the tests import.
 */
export { TOKEN }

export const BUILD = 'dsh-math-tex-1'

// The prompt text itself lives in `./prompt-rules.js`, together with the per-session decision
// about whether to contribute it. Keeping one copy matters: `full` and `minimal` are the
// measured wording, and a second copy here is a second thing to keep in step.

let onLog = () => {}
export function setLogger(fn) {
  onLog = typeof fn === 'function' ? fn : () => {}
}

/** Active config for this process. Set by {@link apply}; defaults keep the module standalone. */
let active = resolveConfig(undefined).config

/**
 * The session a prompt assembly belongs to, or undefined when it cannot be told.
 *
 * `AssembleContext` carries no session identity, so it is read from the initiator the host
 * threads through the turn: in DSH an Agent *is* its session id (`interface Agent { readonly
 * id: SessionId }`). Every failure mode here — no `agents` service, an assembly outside a
 * turn, a disposed service that throws — means "unknown", and the caller decides what an
 * unknown session should be given.
 *
 * @param {unknown} context the `AssembleContext` the section's text function is handed
 * @returns {string | undefined}
 */
function activeSessionId(context) {
  try {
    const agents = typeof context?.get === 'function' ? context.get('agents') : undefined
    const id = agents?.currentInitiator?.()?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/** Guard log rotation cap, so a long-lived host cannot grow the file without bound. */
const LOG_CAP = 512 * 1024

/**
 * Append to the guard log.
 *
 * The session runner writes nothing to disk on its own, so without this a live turn
 * leaves no trace of whether the guard ran, repaired anything, or fired the
 * pre-persistence rewrite. Appends are best-effort: logging must never be able to break
 * a turn, so every failure here is swallowed.
 *
 * @param {string} path absolute path, or '' to disable
 * @param {string} line
 */
function appendLog(path, line) {
  if (!path) return
  try {
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0
    if (size > LOG_CAP) writeFileSync(path, '', 'utf8')
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // Never let logging break a turn.
  }
}

/**
 * Create the log file at mount time, so "the file does not exist" means the plugin never
 * loaded rather than "it loaded and had nothing to say".
 *
 * This distinction cost real debugging time: the mount log line is written through the host
 * logger, so with a `logFile` configured but not yet created, a session where the plugin never
 * loaded and a session where it loaded and stayed silent looked identical from disk.
 *
 * @param {string} path absolute path, or '' to disable
 */
function armLog(path) {
  if (!path) return
  try {
    if (!statSync(path, { throwIfNoEntry: false })) writeFileSync(path, '', 'utf8')
  } catch {
    // A path we cannot create is reported by the caller through the normal log line.
  }
}

/**
 * Scan a buffer for maths regions, mirroring the shipped tokenizer.
 *
 * This is a re-export of the repairer's own scanner rather than a second implementation.
 * An earlier draft kept a near-copy here, and the two drifted: the guard treated a fence
 * as a fence only at column 0 while the repairer allowed indentation, so a release point
 * could land where the repairer saw a region — precisely the disagreement the central
 * invariant forbids. Sharing one function makes that class of bug unrepresentable.
 *
 * @param {string} buf
 * @returns {ReturnType<typeof findMathRegions>}
 */
export function scanRegions(buf) {
  return findMathRegions(buf)
}

/**
 * The largest index of `buf` that may be released now.
 *
 * Everything before the first region that has not closed is settled, because regions
 * never reach backwards: the scanner and the repairer both start a region at a delimiter,
 * never before one. So the release point is that region's start, and the text before it
 * is emitted verbatim.
 *
 * The one thing that must be refused is a cut that splits a delimiter — releasing `$` and
 * leaving `$…` behind makes the remainder pair differently in isolation than in context,
 * which is how three earlier versions produced text that was neither the original nor
 * the repair. If the cut would land inside a run of `$`, the whole run is held instead.
 *
 * @param {string} buf
 * @param {(line: string) => void} [note] sink for the maxHold notice; `safeCut` may be
 *   called on every delta, so the notice must be said once per block rather than per call
 * @returns {number}
 */
export function safeCut(buf, note) {
  let cut = buf.length
  let releaseRegion = false
  // An open code span at the END of the buffer is not settled either: the next backtick
  // closes it and turns a `$` the repair is about to delete into literal text. Measured on
  // the turn that lost 1391 characters — the buffer ended at 810 with the opening backtick
  // of `` `$x_1_2$` ``, the guard released it, the repair removed that `$`, and the closing
  // backtick one release later made the whole rest of the answer unemittable.
  const openSpan = unclosedRunStart(buf)
  if (openSpan >= 0) cut = Math.min(cut, openSpan)
  for (const region of scanRegions(buf)) {
    if (region.complete !== false && !region.unterminated) continue
    let start = region.start
    while (start > 0 && buf[start - 1] === '$') start -= 1
    const splitRun = start < region.start
    if (buf.length - region.start <= active.maxHold) {
      // Nothing from the unclosed region on is settled yet. When the opener follows a `$`
      // run the cut must also fall before that run, since releasing one `$` of a `$$` makes
      // the remainder pair differently on its own than in context.
      cut = Math.min(cut, splitRun ? start : region.start)
      continue
    }
    // Past maxHold the region is released unrepaired rather than stalling the answer on a
    // `$$` the model may never close. Text before it is released either way.
    note?.(
      `releasing unrepaired inside an unclosed region after ${buf.length - region.start} chars (maxHold)`,
    )
    if (splitRun) cut = Math.min(cut, start)
    releaseRegion = true
  }
  if (cut < buf.length - active.maxHold) {
    note?.(`releasing inside an unclosed structure after ${buf.length - cut} chars (maxHold)`)
    return buf.length
  }
  // An oversized region is the one case where the text ON the region must go out too:
  // returning a cut before it would stall the answer on an opener the model never closes.
  return releaseRegion ? buf.length : cut
}

/**
 * The start of a backtick run still waiting for its closing run, or -1.
 *
 * A `$` means one thing inside backticks and another outside them, so the text before an
 * unclosed run is not settled — exactly as the text before an unclosed formula is not
 * settled. This was a real data-loss defect: the release fell on the opening backtick of
 * `` `$x_1_2$` ``, the guard emitted it, the next release found the now-complete span and
 * repaired the `$` away, and because that result no longer extended the text already on
 * screen the guard then held the rest of the answer forever — 199 holds and 1391 of 2213
 * characters lost in one recorded turn.
 *
 * The hold is unconditional, not "only when a delimiter is already inside": at the moment
 * the opening backtick arrives the span is empty, so a delimiter test would let exactly
 * the dangerous release through. Fenced code is exempt (a run of three or more at a line
 * start is literal on both sides of any cut), and `maxHold` still bounds the wait.
 *
 * GFM ends a span at the newline, so an unclosed run on an earlier line is not a span.
 *
 * @param {string} buf
 * @returns {number}
 */
function unclosedRunStart(buf) {
  const n = buf.length
  for (let i = 0; i < n; i++) {
    if (buf[i] !== '`') continue
    if (i > 0 && buf[i - 1] === '`') continue
    let run = 0
    while (i + run < n && buf[i + run] === '`') run += 1
    // A fence (three or more at a line start) is literal and needs no hold — without this
    // exception every streamed code block would be withheld until its closing fence arrived.
    if (run >= 3 && (i === 0 || buf[i - 1] === '\n')) {
      i += run - 1
      continue
    }
    let j = i + run
    let closed = false
    while (j < n && buf[j] !== '\n') {
      if (buf[j] === '`') {
        let close = 0
        while (j + close < n && buf[j + close] === '`') close += 1
        if (close === run) {
          closed = true
          j += close
          break
        }
        j += close
        continue
      }
      j += 1
    }
    if (!closed) return i
    i = j - 1
  }
  return -1
}

/** True when a region record describes something still waiting to close. */
function isOpen(region) {
  return region.unterminated === true || region.complete === false
}

/**
 * One text block's rewriting state.
 *
 * `push` returns the text to emit for this delta (often `''`); `finish` returns the rest.
 * Concatenating every return value yields `repairText(whole text)` with the marker
 * removed.
 *
 * The released text is tracked as `emitted`, and a new release is the *difference*
 * between the repair of everything released so far and what has already gone out.
 * Repairing the whole settled prefix — never a fragment — is what keeps the boundary
 * consistent: a repair that re-frames a region inserts its separators in the gap, which
 * is part of that same repair, so it can never contradict text that was already emitted.
 *
 * @param {{ maxHold?: number, tailBuffer?: number, repairMode?: 'auto' | 'check-only' | 'off', debug?: boolean, log?: (line: string) => void }} [opts]
 */
/**
 * Structural HTML a chat surface will not interpret: the tags reach the reader as visible
 * text. Measured on a real answer (`session-4f7db52f`) that rendered as a wall of `<ol>`,
 * `<li>` and `<b>` mixed with formulas — the model reached for HTML when asked to keep a
 * comparison table on one line, and the Markdown renderer printed the tags verbatim.
 *
 * The pattern is written to survive mathematics in ordinary prose, because a naive
 * `<[a-z][^>]*>` reads `$a<b$ 与 $c>d$` as a tag `<b$ 与 $c>`: a closing tag may be written
 * with whitespace (`</b >`), the two-letter and longer names must be followed by a
 * boundary, and the single-letter names `b`, `i`, `p`, `a` — the ones that appear in
 * comparisons — are only accepted when the tag closes immediately (`<b>`, `<b/>`, `<b x>`).
 *
 * Lowercase only, with no `i` flag: an uppercase `<T>` or `<DIV>` is overwhelmingly a
 * placeholder in reasoning about code, and all 8 HTML-carrying answers in the recorded
 * corpus on this machine (535 answers) write their tags in lowercase.
 */
export const RAW_HTML =
  /<\/?(?:(?:ol|ul|li|em|strong|br|div|span|table|thead|tbody|tr|td|th|blockquote|hr|img)\b[^>]*>|h[1-6]\b[^>]*>|(?:pre|code)\b[^>]*>|(?:b|i|p|a)(?:\s[^>]*)?\s*\/?>|(?:b|i|p|a)\s*>)/

export function createBlockState(opts = {}) {
  const maxHold = Number.isInteger(opts.maxHold) ? opts.maxHold : active.maxHold
  const tailBuffer = Number.isInteger(opts.tailBuffer) ? opts.tailBuffer : Math.max(1, active.tailBuffer)
  const repairMode = opts.repairMode ?? (active.repair === 'off' ? 'off' : active.repair)
  const debug = opts.debug ?? process.env.DSH_MATH_TEX_DEBUG === '1'
  const log = typeof opts.log === 'function' ? opts.log : onLog

  /**
   * Raw text that arrived but has not been folded into the repair yet.
   *
   * Deltas are not settled on arrival: a delta can end between the two `$` of one
   * delimiter, and a repair decided on such a fragment frames the text differently than
   * one decided on the whole. So text is buffered until the release rule says it is safe,
   * and only then repaired.
   */
  let pending = ''
  /**
   * Raw text already folded into the repair.
   *
   * Repairs are NOT compositional — `repair("a $b")` is not a prefix of
   * `repair("a ") + repair("$b")`, because the trailing fragment opens a region the
   * earlier one closed. So a release is never repaired on its own: every settle repairs
   * `rawFolded + pending` as a single unit and emits only what is new. Cumulative repair
   * is what makes the emitted output a monotone prefix extension.
   */
  let rawFolded = ''
  /** The repair of `rawFolded`. */
  let repaired = ''
  /** How much of `repaired` has been emitted. */
  let sentOut = 0
  /** True once the marker has been seen, so it must be stripped from output. */
  let stripping = false
  /**
   * How many repairs have already been written to the log for this block.
   *
   * `settle` re-repairs `rawFolded + pending` from the beginning on every release, so one
   * defect is re-found once per release for the rest of the block. A live session shows
   * what that costs: 61 identical `repaired 1 region(s): blank-line-inside` lines inside two
   * seconds, while the model kept writing paragraphs after the broken region.
   *
   * The repairs themselves are cumulative and are emitted in document order, so the count
   * only ever grows; announcing the growth says everything the per-release lines said, once.
   */
  let announced = 0
  /** True once the maxHold release has been reported, so it is not re-said per delta. */
  let releaseLogged = false
  /** True once this block has been reported as carrying raw HTML. */
  let htmlLogged = false

  /**
   * Repair a settled stretch of text.
   *
   * Text with no delimiter and no backslash cannot hold a region, so it passes through
   * byte-identically — which is also what keeps a plain prose prefix untouched.
   */
  function repairWhole(text) {
    if (text.length === 0) return ''
    const clean = stripping ? text.split(TOKEN).join('') : text
    if (clean.length === 0) return ''
    if (repairMode === 'off') return clean
    if (!clean.includes('$') && !clean.includes('\\')) return clean
    let result
    try {
      result = repairText(clean)
    } catch (err) {
      // A guard that breaks a turn is worse than the defect it prevents.
      log(`repair failed, passing text through: ${err?.message ?? err}`)
      return clean
    }
    const total = result.repairs.length
    let seen = announced
    if (total > seen) {
      const fresh = result.repairs.slice(seen).map((r) => r.reason).join(', ')
      const line = (verb) => `${verb} ${total} region(s) so far: ${fresh}`
      log(repairMode === 'check-only' ? line('would repair') : line('repaired'))
      seen = total
    }
    // Never let the counter run ahead of reality: a repair that a later release stops
    // finding (text superseded by a larger one) must not permanently silence the log.
    announced = Math.min(seen, total)
    return repairMode === 'check-only' ? clean : result.text
  }

  /**
   * Fold every character received so far into the repair, returning the new output.
   *
   * The repair must extend what was already emitted. When it does not — a repair that
   * reached backwards into emitted text — the safe move is to emit nothing and keep the
   * text buffered, because the alternative is output the final answer would contradict.
   */
  function settle() {
    if (pending.length === 0) return ''
    const whole = rawFolded + pending
    const next = repairWhole(whole)
    if (debug) {
      console.error(
        `[dsh-math-tex] settle pending=${pending.length} whole=${whole.length} next=${next.length} ` +
          `repaired=${repaired.length} sentOut=${sentOut} stripping=${stripping}`,
      )
    }
    if (!next.startsWith(repaired) && repaired.length > 0) {
      log(`repair would rewrite emitted text; holding ${pending.length} chars for the next release`)
      return ''
    }
    // Only now is the slice part of the repair. When the repair is refused the slice
    // stays out of `rawFolded`, so the next release attempts it again with more context
    // instead of losing it.
    rawFolded = whole
    pending = ''
    const out = next.length > sentOut ? next.slice(sentOut) : ''
    repaired = next
    sentOut = next.length
    if (!htmlLogged && RAW_HTML.test(out)) {
      htmlLogged = true
      // The chat surface renders Markdown, not HTML: these tags reach the reader as
      // literal text. Deliberately NOT stripped — the guard rewrites TeX it can prove is
      // broken and must not start editing prose — but said out loud once, so the defect is
      // visible in the log instead of only on the screen.
      log('answer contains raw HTML tags; the chat surface renders Markdown, not HTML')
    }
    return out
  }

  return {
    /**
     * @param {string} text
     * @returns {string} text to emit for this delta (may be '')
     */
    push(text) {
      pending += text
      if (pending.includes(TOKEN)) {
        // The marker is one instruction among several, not an end marker: the answer
        // continues after it. Remove it and carry on with the normal release rule, so the
        // text that follows is released like any other.
        stripping = true
        pending = pending.split(TOKEN).join('')
      }
      if (pending.length <= tailBuffer) return ''
      const cut = safeCut(pending.slice(0, pending.length - tailBuffer), (line) => {
        if (releaseLogged) return
        releaseLogged = true
        log(line)
      })
      if (cut <= 0) return ''
      const delta = pending.slice(0, cut)
      const rest = pending.slice(cut)
      pending = delta
      const out = settle()
      // `settle` consumes the whole slice when it succeeds, and nothing when it refuses;
      // either way the unsettled remainder stays buffered.
      pending = pending + rest
      return out
    },

    /**
     * @returns {string} the tail, repaired. Call once, at block end.
     */
    finish() {
      stripping = true
      pending = pending.split(TOKEN).join('')
      return settle()
    },

    get held() {
      return pending.length
    },
  }
}

/**
 * Wrap an upstream chunk iterable.
 *
 * Only `text-delta` chunks are touched, and only their `text` field: the block index, the
 * delta order and every non-text chunk pass through untouched, so reasoning deltas, tool
 * calls and usage frames stay byte-identical.
 *
 * @param {AsyncIterable<{ type: string, index?: number, text?: string, blockType?: string }>} inner
 * @param {{ onLog?: (line: string) => void, maxHold?: number, tailBuffer?: number, repairMode?: 'auto' | 'check-only' | 'off', debug?: boolean }} [opts]
 * @returns {AsyncIterable<object>}
 */
export async function* guardStream(inner, opts = {}) {
  const log = typeof opts.onLog === 'function' ? opts.onLog : onLog
  const states = new Map()
  let current = null
  let seen = 0
  let emitted = 0

  const stateFor = (index) => {
    let s = states.get(index)
    if (!s) {
      s = createBlockState({ ...opts, log })
      states.set(index, s)
    }
    return s
  }

  /**
   * Close the block whose text is still buffered, if any.
   * @param {number} index
   */
  function* flush(index) {
    const out = stateFor(index).finish()
    if (out.length > 0) {
      emitted += 1
      yield { type: 'text-delta', index, text: out }
    }
  }

  for await (const chunk of inner) {
    if (chunk && chunk.type === 'block-start' && chunk.blockType === 'text') {
      // A new text block means the previous one's text is complete even if its
      // `block-end` was not seen.
      if (current !== null && current !== chunk.index) yield* flush(current)
      current = chunk.index
      yield chunk
      continue
    }

    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      seen += 1
      try {
        const out = stateFor(chunk.index).push(chunk.text)
        if (out.length > 0) {
          emitted += 1
          yield { ...chunk, text: out }
        }
      } catch (err) {
        log(`delta failed, passing through: ${err?.message ?? err}`)
        yield chunk
      }
      continue
    }

    if (chunk && chunk.type === 'block-end' && current === chunk.index) {
      yield* flush(current)
      current = null
      yield chunk
      continue
    }

    yield chunk
  }

  for (const index of states.keys()) yield* flush(index)

  log(`guarded stream: ${seen} text delta(s) in, ${emitted} out`)
}

/**
 * Register both defences on a Cordis context.
 *
 * The loader stores the plugin's options in the context's `Config`, so the config is read
 * from there when present and from the plugin argument otherwise. Both defences are
 * best-effort and independent: a host without `systemPrompt` still gets the stream guard,
 * and a host whose configuration is rejected still gets both with defaults, because a
 * plugin that refuses to load is worse than one running with a safe default.
 *
 * Asynchronous because the renderer is loaded before the first turn rather than during it:
 * resolving KaTeX is an `import`, and doing it lazily inside the stream would make the
 * first text delta wait on I/O — the one place in this plugin that must never block.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [inline] config passed directly (tests, or a manual mount)
 * @returns {Promise<void>}
 */
export async function apply(ctx, inline) {
  /* A plugin that fails before its logger exists leaves no trace anywhere: cordis keeps the
   * reason in memory only. So the first two things apply does are unconditional file writes —
   * they need no config and no services, and they turn "the plugin is not running" into an
   * addressable fact. The trace also survives the failure that this wrapper is here to catch. */
  const errFile = join(dshHomePath(), 'profiles', 'desktop', 'dsh-math-tex-apply-error.txt')
  const traceFile = join(dshHomePath(), 'profiles', 'desktop', 'dsh-math-tex-trace.txt')
  const dump = (file, text) => {
    try {
      writeFileSync(file, `${new Date().toISOString()} ${text}\n`)
    } catch {
      // nothing left to report to; failing here would replace the real error
    }
  }
  dump(traceFile, `apply entered by loader (pid ${process.pid}, BUILD=${BUILD})`)
  try {
    return await mountGuard(ctx, inline)
  } catch (err) {
    dump(errFile, `apply failed: ${err?.stack ?? err}`)
    throw err
  }
}

/** The home path the plugin's other file sinks use; kept in one place so both agree. */
function dshHomePath() {
  return String(process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/.dsh`)
    .replace(/[\\/]+$/, '')
}

/** Everything apply used to do; `apply` only adds the crash trace around it. */
async function mountGuard(ctx, inline) {
  // Which config wins: an explicit argument, then the loader-managed Config service, then
  // this plugin's declared defaults.
  let raw = inline
  if (raw === undefined) {
    try {
      raw = ctx?.get?.('Config')?.get?.('dsh-math-tex')
    } catch {
      raw = undefined
    }
  }
  const { config, errors } = resolveConfig(raw)
  active = config

  const sources = []
  if (config.logFile) {
    armLog(config.logFile)
    sources.push((line) => appendLog(config.logFile, line))
    sources.push((line) => `${line}   [file sink: ${config.logFile}]`)
  }
  try {
    const logger = ctx?.get?.('logger')
    if (logger && typeof logger.info === 'function') sources.push((line) => logger.info(line))
  } catch {
    // Keeping the file sink is better than failing the plugin tree.
  }
  setLogger((line) => {
    for (const source of sources) {
      try {
        source(line)
      } catch {
        // A logging sink must never be able to break a turn.
      }
    }
  })
  const log = (line) => onLog(line)
  log(`mounting BUILD=${BUILD}${config.logFile ? ` logFile=${config.logFile}` : ' (host logger only)'}`)

  for (const message of errors) log(`config: ${message}`)
  if (!config.enabled) {
    log(`disabled by config (BUILD=${BUILD}); neither defence is mounted`)
    return
  }

  // Point the oracle at the same renderer build the client uses, then load it once, here,
  // while nothing is streaming. The default resolution already finds the shipped build;
  // `hostDir` only matters when the resolution walk cannot reach the profile's tree.
  const dshHome = process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/.dsh`
  setOracleOptions({
    katexPath: config.katexPath,
    macros: config.macros,
    hostDir: `${dshHome.replace(/[\\/]+$/, '')}/profiles/desktop`,
  })
  const oracle = await loadOracle()
  log(oracle.available ? `oracle: katex ${oracle.version}` : `oracle unavailable: ${oracle.error}`)

  // 1. Pre-emptive prompt rules.
  //
  // The section is registered in every session, but what it SAYS is decided per session and
  // may be nothing: in `auto` mode the rules go only to a session that has carried mathematics,
  // so a chat that never typesets anything is not asked for formulae and never sees the
  // completion marker. See `./prompt-rules.js` for the decision and why it is sticky.
  // `auto` is a decision about WHO gets the rules, not a third wording of them: it hands out
  // the `full` text, to maths sessions only.
  const mode = config.promptRules
  const rules = mode === 'off' ? null : PROMPT_RULES[mode === 'auto' ? 'full' : mode]
  const base = rules ? rules.join('\n') : ''
  const sessionMath = createSessionMath()
  let strayLogged = false
  if (rules) {
    try {
      const sp = ctx.get('systemPrompt')
      if (sp && typeof sp.section === 'function') {
        sp.section({
          name: 'math-output-format',
          order: 1000,
          interpolate: false,
          text: (context) => {
            const sessionId = activeSessionId(context)
            const stray = judgedWithoutSession({ mode: config.promptRules, sessionId, base })
            if (stray && !strayLogged) {
              strayLogged = true
              log(stray)
            }
            return sectionText({ mode: config.promptRules, sessionMath, sessionId, base })
          },
        })
        log(`prompt section "math-output-format" registered (${config.promptRules})`)
      } else {
        log('systemPrompt.section unavailable; prompt rules skipped')
      }
    } catch (err) {
      log(`prompt section failed: ${err?.message ?? err}`)
    }
  } else {
    log('prompt rules disabled by config')
  }

  // 2. The pre-persistence backstop.
  try {
    ctx.on('llm/stream', (options, next) => {
      log(`llm/stream hooked model=${options?.model ?? '?'} mode=${config.repair}`)

      // A request carrying mathematics turns this session into a maths session, which is the
      // only fact `auto` needs. Deciding here rather than at assembly time is deliberate: the
      // request being assembled is the one that STARTS a maths answer, and injecting the rules
      // into that very request would change the cached prefix mid-turn. The request that carries
      // maths gets the rules from the next step on, once the prompt has re-settled.
      if (config.promptRules === 'auto' && requestHasMath(options)) {
        const sessionId = options?.sessionId
        if (!sessionMath.has(sessionId)) log(`prompt rules now apply to session ${sessionId ?? '(unidentified)'}`)
        sessionMath.note(sessionId)
      }

      return guardStream(next(), {
        onLog: log,
        maxHold: config.maxHold,
        tailBuffer: config.tailBuffer,
        repairMode: config.repair,
      })
    })
    log(`listener registered (BUILD=${BUILD})`)
  } catch (err) {
    log(`llm/stream hook failed: ${err?.message ?? err}`)
  }
}

export const name = 'dsh-math-tex'
export const inject = []
