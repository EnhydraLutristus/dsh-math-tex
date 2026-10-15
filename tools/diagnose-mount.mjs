/**
 * 为什么 dsh-math-tex 在宿主里的 fiberPhase 是 failed？
 *
 * 线索：`guard.js` 的 `apply()` 在**任何日志之前**会先做两件事 —— `armLog()`
 * （创建日志文件）和 `await loadOracle()`（加载 KaTeX）。我们检查过模块本身能
 * import，所以失败点几乎必然在这两者之一。这个脚本把安装副本按真实方式挂载一遍，
 * 把 ctx 的每个成员访问都记录下来，并打印真正的异常（宿主只给了 "failed"，没给原因）。
 *
 * 用法：node tools/diagnose-mount.mjs
 */

import { pathToFileURL } from 'node:url'

const PROF = 'C:/Users/SuansDeTus/.dsh/profiles/desktop'
const ENTRY = `${PROF}/node_modules/dsh-math-tex/lib/index.js`

// --- 一个会说真话的假 context：记下每次访问，缺什么都看得见 -------------
const accessed = []
const listeners = new Map()
const ctx = {
  get(key) {
    accessed.push(`get(${key})`)
    if (key === 'systemPrompt') {
      return { section: (spec) => accessed.push(`systemPrompt.section(${spec?.name})`) }
    }
    return undefined
  },
  on(event, handler) {
    accessed.push(`on(${event})`)
    listeners.set(event, handler)
    return () => {}
  },
  effect(fn) {
    accessed.push('effect()')
    return fn?.()
  },
  logger: { info: (l) => console.log(`  [host logger] ${l}`) },
}

const mod = await import(pathToFileURL(ENTRY).href + `?t=${Date.now()}`)
console.log(`入口 import 成功: name=${mod.name} BUILD=${mod.BUILD} inject=${JSON.stringify(mod.inject)}`)

// 日志要写到哪儿？先看配置解析结果 —— apply 用的就是它。
const cfg = mod.resolveConfig({ logFile: `${PROF}/dsh-math-tex.log` })
console.log(`解析后的 logFile: ${cfg.logFile}`)

console.log('\n开始挂载（真实调用 apply）…')
try {
  await mod.apply(ctx)
  console.log('\n挂载成功。ctx 访问顺序：')
  for (const a of accessed) console.log(`  ${a}`)
  console.log(`监听器: ${[...listeners.keys()].join(', ') || '(无)'}`)
} catch (err) {
  console.log(`\n挂载抛异常 —— 这就是 fiberPhase=failed 的原因：`)
  console.log(`  name   : ${err?.name}`)
  console.log(`  message: ${err?.message}`)
  console.log(`  code   : ${err?.code ?? '-'}`)
  console.log('  stack  :')
  for (const line of String(err?.stack ?? '').split('\n').slice(0, 8)) console.log(`    ${line}`)
  console.log('\nctx 访问顺序（停在抛出的那一步之前）：')
  for (const a of accessed) console.log(`  ${a}`)
}

const logPath = `${PROF}/dsh-math-tex.log`
try {
  const { statSync, readFileSync } = await import('node:fs')
  const st = statSync(logPath)
  console.log(`\n日志文件: 存在，${st.size} 字节，mtime ${st.mtime.toISOString()}`)
  console.log(readFileSync(logPath, 'utf8').split('\n').map((l) => `  | ${l}`).join('\n'))
} catch {
  console.log(`\n日志文件: 不存在（${logPath}）—— 说明 apply 在第一次写日志之前就失败了`)
}
