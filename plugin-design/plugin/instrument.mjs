import fs from "node:fs"
const p = process.argv[2]
let s = fs.readFileSync(p, "utf8")
s = s.replace("  function settle() {", "  function settle() {\n    if (process.env.MG_DEBUG) console.error(`S in pendingLen=${pending.length} repairedLen=${repaired.length} sentOut=${sentOut}`)")
s = s.replace("    const next = repairWhole(pending)", "    const next = repairWhole(pending)\n    if (process.env.MG_DEBUG) console.error(`S next.length=${next.length} startsWith=${next.startsWith(repaired)}`)")
s = s.replace("    const out = next.length > sentOut ? next.slice(sentOut) : ''", "    const out = next.length > sentOut ? next.slice(sentOut) : ''\n    if (process.env.MG_DEBUG) console.error(`S outLen=${out.length}`)")
s = s.replace("    return out\n  }", "    if (process.env.MG_DEBUG) console.error('S returning len=' + out.length)\n    return out\n  }")
fs.writeFileSync(p, s)
console.log("patched")
