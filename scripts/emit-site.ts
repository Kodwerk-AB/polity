import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs'
import type { PolityDataset } from '../src/types/polity'

/**
 * Split the dataset into what a consumer actually fetches.
 *
 * The whole file is 2.4MB and the median country is 6.8KB. Someone who wants
 * Sweden's Riksdag should not download 192 other parliaments to get it, so the
 * same build emits per-country files alongside the complete one — a 350×
 * saving for the common case, at the cost of some duplicated bytes in a repo
 * that is already mostly one JSON file.
 *
 * Served from GitHub Pages rather than raw.githubusercontent.com. Raw serves
 * `content-type: text/plain`, so a browser will not parse it as JSON without
 * the consumer overriding it; Pages serves `application/json` and honours
 * CORS. Both stay available — the raw URL is the one that survives a Pages
 * outage, and neither costs anything to keep.
 */

const dataset: PolityDataset = JSON.parse(readFileSync('data/polity.json', 'utf8'))

mkdirSync('site/v1/countries', { recursive: true })

// The complete dataset, unchanged.
copyFileSync('data/polity.json', 'site/v1/polity.json')
copyFileSync('schema/openapi.json', 'site/v1/openapi.json')

// One file per country, keyed by the ISO code a consumer already has.
for (const [iso, country] of Object.entries(dataset.countries)) {
  writeFileSync(`site/v1/countries/${iso}.json`, `${JSON.stringify(country)}\n`)
}

/**
 * An index worth fetching on its own.
 *
 * Enough to render a country list, a picker or a coverage table without
 * pulling any country file: the name, how many chambers, how many seats, and
 * the two fields most likely to be filtered on. 193 rows, a few KB.
 */
const index = {
  schema_version: dataset.schema_version,
  generated_at: dataset.generated_at,
  countries: Object.entries(dataset.countries).map(([iso, country]) => ({
    iso,
    name: country.name,
    form: country.form,
    chambers: country.chambers.length,
    seats: country.chambers.reduce((total, chamber) => total + chamber.seats_total, 0),
    ...(country.democracy ? { democracy: country.democracy.score } : {}),
    // The weakest confidence of any chamber — what a consumer should trust the
    // country to no more than.
    confidence: country.chambers.some(chamber => chamber.confidence === 'flagged')
      ? 'flagged'
      : country.chambers.some(chamber => chamber.confidence === 'partial')
        ? 'partial'
        : 'high',
  })),
  omissions: dataset.omissions,
}
writeFileSync('site/v1/index.json', `${JSON.stringify(index, null, 1)}\n`)

// GitHub Pages runs Jekyll by default, which ignores directories starting with
// an underscore and can rewrite files. Nothing here needs processing.
writeFileSync('site/.nojekyll', '')

const countries = Object.keys(dataset.countries).length
console.log(`wrote site/v1 — ${countries} country files, index, dataset, schema`)
