/**
 * dsh-math-tex — the prompt section's DECISION, kept apart from the guard.
 *
 * The rules below are written to be read by the model while it writes that session's next
 * answer, and they are worth their tokens exactly when the answer will contain mathematics.
 * In a session that never typesets anything they are nine lines of noise in every request of
 * that session, and the receipt line they ask for (`TOKEN`) is visible machinery: the model
 * prints it, the guard strips it, and a reader who looks at the raw stream or an older record
 * sees a marker that means nothing to them.
 *
 * So the section is registered in every session but its TEXT is decided per session, and the
 * decision is sticky for the life of that session:
 *
 *   - `auto` (the default) contributes the rules only to a session that has already carried
 *     mathematics, and contributes the same text on every later step of that session.
 *   - `full` / `minimal` contribute their rules to every session, which is the behaviour
 *     before this module existed.
 *   - `off` contributes nothing.
 *
 * TWO THINGS THE STICKINESS IS FOR, beyond tidiness:
 *
 *   1. A session's system prompt is the cached prefix of every request in it. A section that
 *      appears and disappears re-writes that prefix, so the reader pays for a cache miss on
 *      each flip. Contributing the same text from the first maths turn onwards costs one
 *      re-write per session and nothing after it.
 *   2. The plugin may never lose its own defence silently. `judgedWithoutSession` reports the
 *      one case where the plugin cannot tell which session is being assembled: an unidentifiable
 *      assembly gets no rules, which is also what an unmapped session gets, so without that line
 *      "the prompt half stopped working" would look exactly like "this is not a maths session".
 *
 * WHAT IT MEANS BY MATHEMATICS is deliberately shallow and biased towards INCLUDING the
 * rules: a `$` delimiter anywhere, `\(`, `\[`, `\begin{`, or any `\`-command. A session
 * where the detector fires spuriously carries nine extra lines; a session where it fails to
 * fire while the model writes `$$` is the original red-text failure, arriving unguarded by
 * the prompt half. Nothing here can lose the stream half either way: the repairer runs on
 * every request whatever this module decides.
 *
 * @module prompt-rules
 */

/** Math delimiters and commands that make a conversation a maths conversation. */
const MATH_SHAPES = /\$|\\[([]|\\begin\{|\\[a-zA-Z]{2,}/

/**
 * Completion marker the prompt asks the model to emit after its last line of prose.
 *
 * It is a receipt, not a terminator: it proves the formatting rules were applied, and the
 * answer continues after it. The guard removes the marker wherever it appears, in every
 * mode, including a session where the rules were never contributed — a model that learned
 * the marker from an older prompt must not be able to leak it.
 */
export const TOKEN = '⟪MG-REPAIR⟫'

/**
 * Rules injected into the system prompt, by name. Kept as data so `promptRules` selects a
 * subset and so the tests can measure the exact text the model is given.
 */
export const PROMPT_RULES = {
  full: [
    '## 数学推导的输出格式（必须遵守）',
    '',
    '- 行间公式 `$$ ... $$` 必须单独成段：前后各留一个空行，且 `$$` 必须是该行的开头。',
    '- `$$` 块内只能有公式，不得出现标题、正文、`**粗体**` 或列表项。',
    '- 一个 `$$` 块只放一个公式；多步推导写成多个块，或用 `aligned`/`cases` 环境。',
    '- 标题（`#`/`##`）与正文永远不能与公式粘在同一行。',
    '- 行内公式不要超过约 160 个字符；超长公式改为行间公式。',
    '- 不要用 HTML 标签（`<ol>`、`<li>`、`<b>`、`<div>` 等）排版：这里渲染的是 Markdown，标签会原样显示成文字；需要列表或表格就用 Markdown 语法。',
    '- 推导结束时用纯文本重述结论数值（例如 x=1 时 u≈-0.0092），不要让读者只能从公式里读结论。',
    `- 在正文最后一行之后单独输出 ${TOKEN}（该记号会被自动移除，用于确认格式检查已生效）。`,
  ],
  // The two rules that prevent the reported failure on their own. Everything else in
  // `full` is about readability, and a host with its own style rules may not want it.
  minimal: [
    '## 数学公式格式（必须遵守）',
    '',
    '- 行间公式 `$$ ... $$` 必须单独成段：前后各留一个空行，且 `$$` 必须是该行的开头。',
    '- `$$` 块内只能有公式，不得出现标题、正文、`**粗体**` 或列表项。',
  ],
}

/**
 * How many sessions keep their "mathematics was seen here" mark. A session id costs a few
 * dozen bytes, so this is thousands of sessions' worth; past it the oldest mark is dropped,
 * which can only cost one cache re-write in a session that had gone quiet for that long.
 */
const SESSION_CAP = 512

export function createSessionMath() {
  /** @type {Map<string, true>} insertion-ordered, so the first key is the oldest mark */
  const marked = new Map()
  return {
    /** Remember that this session has carried mathematics. Unidentified calls are ignored. */
    note(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (marked.has(sessionId)) return
      marked.set(sessionId, true)
      while (marked.size > SESSION_CAP) {
        const oldest = marked.keys().next().value
        if (oldest === undefined) break
        marked.delete(oldest)
      }
    },
    has(sessionId) {
      return typeof sessionId === 'string' && marked.has(sessionId)
    },
    /** Marks currently held; exposed so a test can measure the cap rather than trust it. */
    get size() {
      return marked.size
    },
  }
}

/**
 * The session a prompt assembly belongs to.
 *
 * `AssembleContext` carries no session identity — only a plugin-private `scope` and a signal —
 * so identity is read from the initiator the host carries through the turn instead: in DSH an
 * Agent *is* its session id (`interface Agent { readonly id: SessionId }`).
 *
 * @param {unknown} ctx
 * @returns {string | undefined}
 */
function activeSessionId(ctx) {
  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
    const id = agents?.currentInitiator?.()?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    // A disposed service throws; an assembly outside a turn has no initiator at all.
    return undefined
  }
}

/**
 * Every string a message is made of.
 *
 * Requests hold `RequestMessage[]`, whose `content` is a block array (`{ type: 'text', text }`,
 * and the same for reasoning, tool calls and tool results). They arrive from the loop deep
 * frozen, so this walks whatever shape is there and never writes to it.
 *
 * @param {unknown} value
 * @param {string[]} out
 * @param {number} [depth] guards against a cycle in a hand-built request
 */
function collectStrings(value, out, depth = 0) {
  if (depth > 6 || out.length > 64) return
  if (typeof value === 'string') {
    // Only prose can carry a delimiter; a huge tool result is not where the question was asked.
    if (value.length <= 100_000) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1)
  }
}

/**
 * Does this request carry mathematics?
 *
 * The model's own prior answers count: a session where the assistant already wrote `$$` is a
 * maths session even when the current question is "继续". `GenerateOptions.system` is excluded
 * on purpose — it is assembly output, and a host whose prompt mentions TeX would otherwise
 * mark every session of that host as a maths session.
 *
 * @param {unknown} options the `llm/stream` options object
 * @returns {boolean}
 */
export function requestHasMath(options) {
  if (!options || typeof options !== 'object') return false
  const strings = []
  try {
    collectStrings(options.messages, strings)
  } catch {
    return false
  }
  return strings.some((text) => MATH_SHAPES.test(text))
}

/**
 * The rules text for one assembly, or '' when this session should get none.
 *
 * `sessionMath` is undefined only where there is no session to identify, which is also the
 * only case that is reported: an unidentifiable assembly still gets the rules, because the
 * failure that costs the reader something is a maths answer arriving unformatted.
 *
 * @param {object} args
 * @param {'full'|'minimal'|'off'|'auto'} args.mode the configured `promptRules`
 * @param {ReturnType<typeof createSessionMath>} args.sessionMath
 * @param {string | undefined} args.sessionId session being assembled, when known
 * @param {string} args.base the rules for `mode`, precomputed by the guard
 * @returns {string}
 */
export function sectionText({ mode, sessionMath, sessionId, base }) {
  const rules = mode === 'auto' ? (sessionMath.has(sessionId) ? base : '') : base
  // Assembled sections are concatenated, so an empty contribution has to be exactly empty:
  // a lone newline would accumulate one blank line per step.
  return rules
}

/**
 * The one case the plugin cannot decide, reported so the caller can log it.
 *
 * This is a HEALTH report, not a fallback: a section's text function is handed an
 * `AssembleContext` with no session identity, and this plugin reads identity from the
 * initiator. If DSH ever assembles a prompt with no initiator on the stack, every session's
 * section silently decides "not a maths session" and the prompt half of the defence stops
 * existing. One line in the log turns that from a mystery into a fact.
 *
 * @param {object} args
 * @param {'full'|'minimal'|'off'|'auto'} args.mode
 * @param {string | undefined} args.sessionId
 * @param {string} args.base the rules for `mode`
 * @returns {string | undefined} a log line, or undefined when the decision was made normally
 */
export function judgedWithoutSession({ mode, sessionId, base }) {
  if (mode !== 'auto' || sessionId !== undefined || base === '') return undefined
  return 'prompt section: no initiator on this assembly; only already-marked sessions get the rules'
}
