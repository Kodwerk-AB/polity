import { mkdirSync, writeFileSync } from 'node:fs'
import { build } from '../src/build'
import { extractionCount } from '../src/extract/model'
import { requestCount } from '../src/net/wiki'
import { summarise, validateDataset } from '../src/validate/dataset'

const only = process.argv.slice(2).filter(argument => /^[A-Z]{2}$/.test(argument))
const started = Date.now()
const dataset = await build(only.length ? only : undefined)

mkdirSync('data', { recursive: true })
const path = only.length ? 'data/sample.json' : 'data/polity.json'
writeFileSync(path, `${JSON.stringify(dataset, null, 1)}\n`)

const issues = validateDataset(dataset)
writeFileSync('data/issues.json', `${JSON.stringify(issues, null, 1)}\n`)

const list = Object.values(dataset.countries)
const chambers = list.flatMap(country => country.chambers)
const rows = chambers.flatMap(chamber => chamber.composition)
const parties = new Set(list.flatMap(country => Object.keys(country.parties)))
const at = (level: string) => chambers.filter(chamber => chamber.confidence === level).length

console.log(`\nwrote ${path} — ${summarise(dataset, issues)}`)
console.log(`chambers ${chambers.length}: high ${at('high')}, partial ${at('partial')}, flagged ${at('flagged')}`)
console.log(`seat rows ${rows.length}, linked ${rows.filter(row => row.party).length} (${Math.round((rows.filter(row => row.party).length / rows.length) * 100)}%)`)
console.log(`parties ${parties.size}`)
console.log(`requests ${requestCount()}, model calls ${extractionCount()}, ${Math.round((Date.now() - started) / 1000)}s`)

for (const omission of dataset.omissions) console.log(`  OMITTED ${omission.iso}: ${omission.reason}`)
const errors = issues.filter(issue => issue.severity === 'error')
for (const issue of errors.slice(0, 25)) {
  console.log(`  ERROR ${issue.iso}${issue.chamber ? ` / ${issue.chamber}` : ''}: ${issue.message}`)
}
if (errors.length > 25) console.log(`  … ${errors.length - 25} more errors in data/issues.json`)
