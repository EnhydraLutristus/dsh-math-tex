/**
 * Load the same KaTeX build the oracle uses, for the tests that need the raw renderer.
 *
 * WHY THIS IS A MODULE AND NOT TWO LINES IN EACH TEST
 *
 *   The oracle reports the specifier it resolved, and on this host that is a bare package
 *   SPECIFIER (`katex`) because it was reached through `createRequire(...).resolve()`. A
 *   bare specifier cannot be turned into a URL — `pathToFileURL('katex')` throws or, worse,
 *   resolves against the current directory — and a DIRECTORY cannot be imported either. So
 *   the entry has to be resolved the way Node resolves it, then converted, and both the
 *   `main` and the `exports` shape have to be tolerated because KaTeX 0.16.47 ships an ESM
 *   `dist/katex.mjs` while older builds shipped CommonJS.
 *
 * The renderer is only needed to CROSS-CHECK what the oracle reported, so this loader is
 * deliberately independent of the oracle's own loading: a bug that made both wrong the same
 * way would otherwise be invisible.
 *
 * Run: imported by the test files, not executed.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

/**
 * Resolution roots, in the order the plugin itself uses them.
 *
 * The suite usually runs from a source checkout, which has no `node_modules` of its own,
 * so a bare `require.resolve('katex')` fails there — measured, and the reason this list
 * exists. The host profile is where the renderer actually lives, so it is tried explicitly
 * (the same place `lib/tex-repair.js` resolves from, via `DSH_HOME`).
 */
const HOST_DIRS = [
  process.env.DSH_HOME ? `${process.env.DSH_HOME.replace(/[\\/]+$/, '')}/profiles/desktop` : null,
  `${(process.env.USERPROFILE ?? process.env.HOME ?? '').replace(/[\\/]+$/, '')}/.dsh/profiles/desktop`,
].filter(Boolean)

/**
 * @returns {Promise<{ katex: any, entry: string, version: string }>}
 */
export async function loadKatex() {
  const attempts = []
  const resolved = []
  for (const dir of [...HOST_DIRS, null]) {
    try {
      const req = dir ? createRequire(`${dir}/package.json`) : createRequire(import.meta.url)
      const hit = req.resolve('katex')
      if (!resolved.includes(hit)) resolved.push(hit)
    } catch (err) {
      attempts.push(`resolve from ${dir ?? 'the test directory'}: ${err?.message ?? err}`)
    }
  }

  const candidates = []
  for (const hit of resolved) {
    // A resolved path may be a directory; the package's own entry field is then what
    // `import()` needs, so read it rather than guessing a file name.
    if (existsSync(hit) && !/\.(js|mjs|cjs)$/.test(hit)) {
      const pkgJson = `${hit.replace(/[\\/]+$/, '')}/package.json`
      if (existsSync(pkgJson)) {
        const pkg = createRequire(import.meta.url)(pkgJson)
        const dot = pkg.exports?.['.']
        const main = typeof pkg.exports === 'string'
          ? pkg.exports
          : (typeof dot === 'string' ? dot : dot?.import ?? dot?.default)
            ?? pkg.module
            ?? pkg.main
        if (main) candidates.push(`${hit.replace(/[\\/]+$/, '')}/${String(main).replace(/^\.\//, '')}`)
      }
    }
    candidates.push(hit)
  }
  candidates.push('katex')

  for (const candidate of candidates) {
    const specifier = /^[a-zA-Z]:[\\/]/.test(candidate) || /^[\\/]/.test(candidate) ? pathToFileURL(candidate).href : candidate
    try {
      const mod = await import(specifier)
      const api = mod?.default ?? mod
      if (typeof api?.renderToString === 'function') {
        return { katex: api, entry: candidate, version: api.version ?? '(unknown)' }
      }
      attempts.push(`${candidate}: no renderToString`)
    } catch (err) {
      attempts.push(`${candidate}: ${err?.message ?? err}`)
    }
  }
  throw new Error(`could not load katex for the test suite (${attempts.join('; ')})`)
}
