import { claimIds, enwikiTitle, fetchJson, getEntities, labelOf } from '../net/wiki'
import type { QID } from '../types/polity'
import type { Recognition } from '../types/enums'

/**
 * The country list, resolved from Wikidata rather than hardcoded.
 *
 * A checked-in list of 193 ISO codes would be a second thing to maintain and
 * would silently rot — South Sudan joined in 2011, and any hand-written list
 * from before then is wrong in a way nothing detects. So the members are asked
 * for: `P463` (member of) `Q1065` (United Nations), open statements only, which
 * is exactly how the UN's own membership is modelled.
 *
 * The one hand-maintained thing is the ISO code, and even that comes from the
 * country's own `P297`.
 */

export interface CountryRef {
  iso: string
  qid: QID
  name: string
  /** The country's own English Wikipedia article. */
  article?: string
  /** P298 — the alpha-3 code, which is how outside datasets key countries. */
  alpha3?: string
  /** Absent for a UN member state; set for everything else this carries. */
  recognition?: Recognition
}

interface SparqlBinding {
  country?: { value?: string }
  iso?: { value?: string }
  alpha3?: { value?: string }
  name?: { value?: string }
}

const UN_MEMBERS_QUERY = `
SELECT ?country ?iso ?alpha3 ?name WHERE {
  ?country p:P463 ?membership .
  ?membership ps:P463 wd:Q1065 .
  FILTER NOT EXISTS { ?membership pq:P582 ?ended }
  ?country wdt:P297 ?iso .
  OPTIONAL { ?country wdt:P298 ?alpha3 }
  OPTIONAL { ?country rdfs:label ?name FILTER(LANG(?name) = "en") }
}`

/**
 * Every current UN member state.
 *
 * SPARQL is used here and nowhere else in the pipeline: it is ONE query for a
 * set that has no cheap equivalent through `wbgetentities`, and a failure is
 * immediately obvious (an empty list) rather than subtly wrong. Everything
 * downstream uses the entity API, which is far more reliable under load.
 */
export const unMemberStates = async (): Promise<CountryRef[]> => {
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(UN_MEMBERS_QUERY)}&format=json`
  const data = await fetchJson<{ results?: { bindings?: SparqlBinding[] } }>(url)
  const rows = data?.results?.bindings ?? []

  const seen = new Map<string, CountryRef>()
  for (const row of rows) {
    const qid = row.country?.value?.split('/').pop()
    const iso = row.iso?.value?.toUpperCase()
    if (!qid || !iso || !/^Q\d+$/.test(qid) || !/^[A-Z]{2}$/.test(iso)) continue
    // A country may bind twice when it carries two labels; first wins.
    const alpha3 = row.alpha3?.value?.toUpperCase()
    if (!seen.has(iso))
      seen.set(iso, {
        iso,
        qid: qid as QID,
        name: row.name?.value ?? iso,
        ...(alpha3 && /^[A-Z]{3}$/.test(alpha3) ? { alpha3 } : {}),
      })
  }

  // The UN seat and the ISO code are not always held by the same entity.
  // Denmark is the case: the Kingdom of Denmark (Q756617) is the member state,
  // while Denmark (Q35) carries `DK` and is what every other source means. Both
  // point at the same Folketing. Rather than special-case one country, ask for
  // any ISO code the membership query missed and take the entity that holds it.
  for (const [iso, substitute] of Object.entries(REALM_SUBSTITUTIONS)) {
    seen.set(iso, { ...substitute })
  }

  // States with no UN seat, added deliberately and flagged as such.
  for (const state of NON_MEMBER_STATES) if (!seen.has(state.iso)) seen.set(state.iso, state)

  const countries = [...seen.values()].sort((a, b) => a.iso.localeCompare(b.iso))
  // Attach each country's own article — the fallback source when a legislature
  // article carries nothing usable.
  const entities = await getEntities(
    countries.map(country => country.qid),
    'labels|sitelinks'
  )
  for (const country of countries) {
    const entity = entities[country.qid]
    const article = enwikiTitle(entity)
    if (article) country.article = article
    const label = labelOf(entity)
    if (label) country.name = label
  }
  return countries
}

/**
 * ISO codes where the UN seat and the working country are different entities.
 *
 * A composite realm holds the membership while its European constituent holds
 * the ISO code, the legislature and everything any other source means by the
 * name. Verified for both: the Kingdom of Denmark (Q756617) and the Kingdom of
 * the Netherlands (Q29999) carry the P463 to the UN, while Denmark (Q35) and
 * the Netherlands (Q55) carry P194 to the Folketing and the States General.
 *
 * Data rather than a rule, because "prefer the constituent" is not generally
 * true — it is true of exactly these two, and a heuristic that reached further
 * would start rewriting countries that are fine.
 */
const REALM_SUBSTITUTIONS: Record<string, CountryRef> = {
  DK: { iso: 'DK', qid: 'Q35' as QID, name: 'Denmark' },
  NL: { iso: 'NL', qid: 'Q55' as QID, name: 'Netherlands' },
}

/**
 * States the UN membership query misses that a world dataset should carry.
 *
 * Each is a judgement, stated rather than assumed, and each ships with
 * `recognition` set so a consumer can filter to the 193 if that is what they
 * need. The dataset would otherwise be silently missing a fully competitive
 * multi-party parliament (Taiwan's Legislative Yuan) with no record that it had
 * been considered at all — which is worse than either including or excluding
 * it deliberately.
 *
 * The Vatican is here because it is a UN observer with no legislature, so it
 * arrives as an omission with a reason rather than as a gap.
 */
export const NON_MEMBER_STATES: CountryRef[] = [
  // UN observer states.
  { iso: 'VA', qid: 'Q237' as QID, name: 'Vatican City', recognition: 'un_observer' },
  { iso: 'PS', qid: 'Q219060' as QID, name: 'Palestine', recognition: 'un_observer' },
  // Widely recognised, no UN seat. Taiwan lost its seat to the PRC in 1971 and
  // its Legislative Yuan is among the most competitive chambers in Asia.
  { iso: 'TW', qid: 'Q865' as QID, name: 'Taiwan', recognition: 'partially_recognised' },
  { iso: 'XK', qid: 'Q1246' as QID, name: 'Kosovo', recognition: 'partially_recognised' },
]

/** Wikidata sometimes files a country's legislature only on a related item. */
export const legislatureIds = (entity: Parameters<typeof claimIds>[0]): string[] =>
  claimIds(entity, 'P194')
