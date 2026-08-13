import { writeFileSync } from 'node:fs'
import { unMemberStates } from '../src/resolve/countries'
import { chambersOf, type ChamberRef } from '../src/resolve/chambers'
import { requestCount } from '../src/net/wiki'

const countries = await unMemberStates()
console.log(`resolving chambers for ${countries.length} states…`)
const out: Record<string, { qid: string; name: string; article?: string; chambers: ChamberRef[] }> = {}
let done = 0, none = 0
for (const c of countries) {
  const chambers = await chambersOf(c.qid)
  if (!chambers.length) none++
  out[c.iso] = { qid: c.qid, name: c.name, ...(c.article ? { article: c.article } : {}), chambers }
  done++
  if (done % 20 === 0) process.stdout.write(`\r  ${done}/${countries.length} (${none} unresolved, ${requestCount()} requests)`)
}
console.log(`\ndone: ${done}, unresolved: ${none}, requests: ${requestCount()}`)
writeFileSync('data/chambers.json', JSON.stringify(out, null, 1))
const shapes: Record<string, string[]> = {}
for (const [iso, v] of Object.entries(out)) {
  const k = v.chambers.map(x => x.role).sort().join('+') || 'NONE'
  ;(shapes[k] ??= []).push(iso)
}
for (const [k, v] of Object.entries(shapes).sort((a,b)=>b[1].length-a[1].length))
  console.log(`${String(v.length).padStart(4)}  ${k.padEnd(14)} ${v.length<=20?v.join(' '):v.slice(0,20).join(' ')+' …'}`)
const noArticle = Object.entries(out).flatMap(([iso,v])=>v.chambers.filter(c=>!c.article).map(c=>`${iso}:${c.name}`))
console.log(`\nchambers with no article: ${noArticle.length}`)
if (noArticle.length) console.log('  ' + noArticle.join('\n  '))
