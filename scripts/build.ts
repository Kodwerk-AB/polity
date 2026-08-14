import { mkdirSync, writeFileSync } from 'node:fs'
import { build } from '../src/build'
import { extractionCount } from '../src/extract/model'
import { requestCount } from '../src/net/wiki'
import { summarise, validateDataset } from '../src/validate/dataset'

const only = process.argv.slice(2).filter(argument => /^[A-Z]{2}$/.test(argument))
const started = Date.now()
const dataset = await build(only.length ? only : undefined)

const issues = validateDataset(dataset)

// Validate BEFORE writing. A schema-breaking value used to reach the published
// file and fail `bun run validate` afterwards — Tanzania's Attorney General
// carried standing "residual", a real value from the wrong vocabulary — by
// which point the bad data was already on disk and, on that occasion, pushed.
// An error here means the run produced something the schema forbids, so the
// previous file is the better one to keep.
const blocking = issues.filter(issue => issue.severity === 'error')
if (blocking.length && !only.length) {
  for (const issue of blocking.slice(0, 10)) {
    console.error(`  ERROR ${issue.iso ?? ''} ${issue.message ?? JSON.stringify(issue)}`)
  }
  throw new Error(
    `${blocking.length} validation error(s) — refusing to overwrite data/polity.json`
  )
}

mkdirSync('data', { recursive: true })
const path = only.length ? 'data/sample.json' : 'data/polity.json'
writeFileSync(path, `${JSON.stringify(dataset, null, 1)}\n`)
// A few-country run is a probe, not the dataset. Writing its issue list to the
// shared file replaced 193 countries' findings with nine countries' — and an
// empty result then read as "no errors anywhere" rather than "not checked".
if (!only.length) writeFileSync('data/issues.json', `${JSON.stringify(issues, null, 1)}\n`)

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
