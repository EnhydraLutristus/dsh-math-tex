/* Independent proof, run against the INSTALLED entry the loader imports:
 * does the loader's own config-resolution step survive this plugin's `Config` export?
 *
 * cordis resolves an entry's config with `resolveConfig(runtime, config)`, which calls
 * `runtime.Config['~standard'].validate(config)`. A plain JSON Schema object has no
 * `~standard`, so before this fix that call threw inside the fiber's `_reload()`, which
 * caught it and marked the fiber FAILED — the plugin never reached `apply` at all.
 */
import { spawnSync } from 'node:child_process'

const entry = 'file:///C:/Users/SuansDeTus/.dsh/profiles/desktop/node_modules/dsh-math-tex/lib/index.js'
const probe = `
const mod = await import(${JSON.stringify(entry)})
const Config = Reflect.get(mod, 'Config')
if (typeof Config !== 'function' || !Config['~standard']) {
  console.log(JSON.stringify({ ok: false, why: 'Config is not a native schema instance' }))
} else {
  const r = Config['~standard'].validate({ logFile: 'probe.log' })
  console.log(JSON.stringify({ ok: !r.issues, value: r.value, issues: r.issues ?? null }))
}
`
const res = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' })
console.log('--- loader config resolution ---')
console.log(res.stdout.trim() || res.stderr.trim())
const parsed = JSON.parse(res.stdout.trim().split('\n').pop())
if (!parsed.ok) throw new Error('the loader would fail on this Config export')
console.log('VERDICT: the loader can resolve this plugin\'s config -> the fiber can start')
