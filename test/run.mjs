/**
 * Run the whole suite, in order of increasing blast radius.
 *
 * Read the order as the argument for trusting the plugin:
 *   1. `guard-test`      — does the judge and the region scanner agree with the renderer?
 *   2. `red-render-test` — does it catch the three ways a region can turn red?
 *   3. `e2e-test`        — does a real transcript come out readable, end to end?
 *   4. `regression-test` — do the defects that reached a real transcript stay fixed?
 *   5. `wire-test`       — is the streamed output identical to the single-pass repair?
 *   6. `fuzz-test`       — does that hold under 236 arbitrary chunkings?
 *   7. `config-test`     — do the documented options do what they say?
 *   8. `smoke-test`      — does the package load the way the host loads it?
 *   9. `installed-test`  — does the copy IN THE PROFILE load and behave the same way?
 *
 * Exit code is non-zero if any file fails, so `npm test` is usable in CI.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SUITE = [
  'guard-test.mjs',
  'red-render-test.mjs',
  'e2e-test.mjs',
  'regression-test.mjs',
  'wire-test.mjs',
  'fuzz-test.mjs',
  'config-test.mjs',
  'smoke-test.mjs',
  'installed-test.mjs',
]

let failed = 0
for (const file of SUITE) {
  process.stdout.write(`\n=== ${file} ===\n`)
  const res = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' })
  if (res.status !== 0) {
    failed += 1
    process.stdout.write(`--- ${file} FAILED (exit ${res.status ?? res.signal})\n`)
  }
}

process.stdout.write(failed === 0 ? `\nAll ${SUITE.length} test files passed.\n` : `\n${failed} of ${SUITE.length} test files failed.\n`)
process.exit(failed === 0 ? 0 : 1)
