/**
 * Check the published dataset against the published schema.
 *
 * This is not a formality. The schema seals every object with
 * `additionalProperties: false`, so it catches the one class of error nothing
 * else does: a field the generator writes that the schema never described.
 * The first run of this check found `government.authority` on all 193
 * countries, absent from the schema entirely, plus two format mismatches — none
 * of which the type system or the validator could see, because both describe
 * intent rather than the file on disk.
 *
 * Run against data/polity.json, or a path given as the first argument.
 */

import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { readFileSync } from 'node:fs'

const target = process.argv[2] ?? 'data/polity.json'
const spec = JSON.parse(readFileSync('schema/openapi.json', 'utf8'))
const data = JSON.parse(readFileSync(target, 'utf8'))

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const validate = ajv.compile({
  ...spec.components.schemas.PolityDataset,
  components: spec.components,
})

if (validate(data)) {
  const countries = Object.keys(data.countries).length
  console.log(`${target} validates against schema/openapi.json — ${countries} countries`)
  process.exit(0)
}

// Errors are grouped by SHAPE rather than listed one by one: a single missing
// field produces 193 identical failures, and the count is the useful part.
const grouped = new Map()
for (const error of validate.errors) {
  const path = error.instancePath
    .replace(/\/countries\/[A-Z]{2}/, '/countries/[iso]')
    .replace(/\/\d+/g, '/[]')
    .replace(/\/parties\/Q\d+/, '/parties/[qid]')
  const detail =
    error.params.additionalProperty ??
    error.params.allowedValues?.join('|') ??
    error.params.pattern ??
    ''
  const key = `${path} ${error.keyword} ${detail}`.trim()
  grouped.set(key, (grouped.get(key) ?? 0) + 1)
}

console.error(`${target} FAILED schema validation — ${validate.errors.length} errors\n`)
for (const [key, count] of [...grouped].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.error(`  ${String(count).padStart(5)}  ${key}`)
}
if (grouped.size > 30) console.error(`  … ${grouped.size - 30} more shapes`)
process.exit(1)
