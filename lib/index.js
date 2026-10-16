/**
 * dsh-math-tex — keeps a DSH maths answer readable.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * The chat renderer renders Markdown maths with KaTeX and, on any input it cannot parse,
 * falls back to showing the raw source in its error colour. There is no crash and no
 * logged error: a single badly framed `$$` can turn an entire derivation into what the
 * user described as "一篇血红色". The frontend is one bundle inside `app.asar` and passes
 * no KaTeX options, so this cannot be fixed at the renderer. It is fixed before the text
 * is persisted.
 *
 * TWO DEFENCES, ONE PURPOSE
 *
 *   1. Prompt rules that make the failure much less likely: a display block on its own
 *      paragraph, nothing but maths inside `$$`.
 *   2. A guard on the host's `llm/stream` waterfall that inspects every maths region with
 *      the same KaTeX build the client uses, and rewrites the ones that would render red —
 *      before they are written to the session log, so the transcript, the renderer and any
 *      later export all see the repaired text.
 *
 * Neither defence deletes mathematics. A region that cannot be rendered is re-framed, has
 * its known-bad command neutralised, or is shown as fenced source, so the reader always
 * ends up with the author's formula rather than a red blob.
 *
 * CONFIGURATION
 *
 * Every option is documented in {@link ./config.js} and in README.md. Defaults are the
 * behaviour the test suite measures, so an empty `config:` block is the tested build.
 *
 * @module dsh-math-tex
 */

export {
  TOKEN,
  BUILD,
  apply,
  setLogger,
  scanRegions,
  safeCut,
  createBlockState,
  guardStream,
  name,
  inject,
} from './guard.js'

export {
  ERROR_COLOR,
  rendersRed,
  judge,
  echoedErrorText,
  findMathRegions,
  recoverRedRegion,
  texOf,
  inspect,
  releaseRegion,
  repairText,
  inspectText,
  loadOracle,
  oracleStatus,
  ensureOracle,
  oracleSnapshot,
  setOracleOptions,
} from './tex-repair.js'

export { Config, ConfigSchema, DEFAULTS, resolveConfig } from './config.js'

export {
  PROMPT_RULES,
  createSessionMath,
  requestHasMath,
  sectionText,
  judgedWithoutSession,
} from './prompt-rules.js'
