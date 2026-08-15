import { IMAGE_RESTRICTIONS, type ImageRestriction } from '../types/enums'
import { cacheRead, cacheWrite } from './cache'

/**
 * Wikidata and Wikipedia clients.
 *
 * One retry-with-backoff fetch, one cache, one place that knows the API shapes.
 * Wikimedia asks for a descriptive User-Agent with contact details and enforces
 * it — an anonymous scripted fetch gets 429s much sooner.
 */

const USER_AGENT = 'polity/0.1 (https://github.com/ikethepike/polity; dataset build)'
const REQUEST_TIMEOUT_MS = 30_000

/** Wikimedia serves these fast; a month is plenty for entity claims. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

let liveRequests = 0
export const requestCount = () => liveRequests

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * JSON fetch with backoff, cached to disk.
 *
 * A 429 is honoured via `Retry-After` when the server sends one. Six attempts,
 * then undefined — a single unreachable entity must not end a two-hour run.
 */
export const fetchJson = async <T>(url: string, ttlMs = DEFAULT_TTL_MS): Promise<T | undefined> => {
  const cached = cacheRead<T>(url, ttlMs)
  if (cached !== undefined) return cached

  for (let attempt = 1; attempt <= 6; attempt++) {
    liveRequests++
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => undefined)

    if (response?.ok) {
      const parsed = (await response.json().catch(() => undefined)) as T | undefined
      if (parsed !== undefined) {
        cacheWrite(url, parsed)
        return parsed
      }
    }
    if (response?.status === 404) return undefined

    const retryAfter = Number(response?.headers.get('retry-after'))
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * attempt)
  }
  console.warn(`  giving up: ${url.slice(0, 120)}`)
  return undefined
}

// ---------------------------------------------------------------------------
// Wikidata
// ---------------------------------------------------------------------------

export interface Snak {
  mainsnak?: { datavalue?: { value?: unknown } }
  rank?: 'preferred' | 'normal' | 'deprecated'
  qualifiers?: Record<string, { datavalue?: { value?: unknown } }[]>
}

export interface WikidataEntity {
  labels?: Record<string, { value?: string }>
  descriptions?: Record<string, { value?: string }>
  claims?: Record<string, Snak[]>
  sitelinks?: Record<string, { title?: string }>
}

/**
 * Entities by id, in batches of 50 — the API's own ceiling.
 *
 * `wbgetentities` truncates its response at 12MB and says so only in a
 * `warnings` field, so props are always narrowed to what the caller asked for
 * rather than fetched whole.
 */
export const getEntities = async (
  ids: string[],
  props = 'claims|labels|sitelinks'
): Promise<Record<string, WikidataEntity>> => {
  const out: Record<string, WikidataEntity> = {}
  const unique = [...new Set(ids)].filter(Boolean)
  for (let index = 0; index < unique.length; index += 50) {
    const batch = unique.slice(index, index + 50)
    const url =
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join('|')}` +
      `&props=${encodeURIComponent(props)}&languages=en&languagefallback=1&sitefilter=enwiki&format=json`
    const data = await fetchJson<{ entities?: Record<string, WikidataEntity> }>(url)
    Object.assign(out, data?.entities ?? {})
  }
  return out
}

/** The `id` of an entity-valued statement. */
export const claimId = (statement: Snak): string | undefined =>
  (statement.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id

/** All entity ids for a property, in statement order. */
export const claimIds = (entity: WikidataEntity | undefined, property: string): string[] =>
  (entity?.claims?.[property] ?? []).map(claimId).filter((id): id is string => !!id)

/** A quantity-valued statement's amount. */
export const claimAmount = (statement: Snak): number | undefined => {
  const raw = (statement.mainsnak?.datavalue?.value as { amount?: string } | undefined)?.amount
  return raw === undefined ? undefined : Number(raw)
}

/** A string-valued statement (P154 logo filenames, P465 colours). */
export const claimStrings = (entity: WikidataEntity | undefined, property: string): string[] =>
  (entity?.claims?.[property] ?? [])
    .map(statement => statement.mainsnak?.datavalue?.value)
    .filter((value): value is string => typeof value === 'string')

const timeOf = (statement: Snak, property: string): string | undefined =>
  (statement.qualifiers?.[property]?.[0]?.datavalue?.value as { time?: string } | undefined)?.time

/** A `+2025-01-20T00:00:00Z` time value as `2025-01-20`, or undefined when the
 *  precision is coarser than a day (Wikidata writes `00` for unknown parts). */
export const dayPrecision = (time: string | undefined): string | undefined => {
  if (!time) return undefined
  const date = time.replace(/^\+/, '').slice(0, 10)
  return /^\d{4}-(?!00)\d{2}-(?!00)\d{2}$/.test(date) ? date : undefined
}

/**
 * THE incumbency rule, and the most load-bearing function here.
 *
 * Measured on the United States' P6: 46 statements, exactly one `preferred`
 * with no end date. The rank system works when maintained — but a naive
 * "no end date" filter returns TWO current prime ministers for Estonia, whose
 * predecessor's statement was never closed.
 *
 * So: open statements only, then preferred, then the latest start. A statement
 * with an end date is never current however it is ranked.
 */
export const currentStatement = (statements: Snak[] | undefined): Snak | undefined =>
  resolveStatement(statements).statement

export interface Resolution {
  statement?: Snak
  /**
   * True when every statement had an end date and the latest was taken anyway.
   *
   * Colombia and Guinea-Bissau are the cases: their heads of state carry only
   * CLOSED statements, because the source is mid-transition and nobody has
   * opened the successor's yet. Omitting the country entirely is the worse
   * answer — the office exists and somebody holds it — so the most recent
   * holder is reported and the caller lowers confidence.
   */
  stale: boolean
}

export const resolveStatement = (
  statements: Snak[] | undefined,
  /** Today, as `YYYY-MM-DD`. Injectable so the rule is testable. */
  today = new Date().toISOString().slice(0, 10)
): Resolution => {
  const live = (statements ?? []).filter(statement => statement.rank !== 'deprecated')
  const byStart = (pool: Snak[]) =>
    [...pool].sort((a, b) => (timeOf(b, 'P580') ?? '').localeCompare(timeOf(a, 'P580') ?? ''))[0]

  // Current means BEGUN AND NOT YET ENDED — both judged against today.
  //
  // Nothing here previously knew what day it was, so both halves were wrong in
  // opposite directions, and Hungary showed both in one office. Its presidency
  // reads: Tamás Sulyok to 19 July 2026, Ágnes Forsthoffer interim from 20
  // July to 18 August, then András Baka from the 19th.
  //
  //   - Baka's term has not started. "Latest start wins" actively PREFERS him,
  //     so he was published as the sitting president four days early.
  //   - Forsthoffer's term has not ended, but it carries an end DATE, and a
  //     bare "has a P582" test reads that as already over — writing off the
  //     one person actually holding the office today.
  //
  // Filtering on the dates rather than on the presence of a qualifier gets
  // both right, and leaves `stale` meaning what it says: every term this
  // office has is finished.
  const begun = live.filter(statement => {
    const start = dayPrecision(timeOf(statement, 'P580'))
    return !start || start <= today
  })

  const ended = (statement: Snak) => {
    if (!statement.qualifiers?.P582?.length) return false
    const end = dayPrecision(timeOf(statement, 'P582'))
    // An end date we cannot read to the day is trusted as an ending, which is
    // the pre-existing behaviour and the safe direction: it retires a term
    // rather than inventing an incumbency.
    return !end || end <= today
  }

  const open = begun.filter(statement => !ended(statement))
  if (open.length) {
    const preferred = open.filter(statement => statement.rank === 'preferred')
    const chosen = byStart(preferred.length ? preferred : open)
    return chosen ? { statement: chosen, stale: false } : { stale: false }
  }
  // Nothing open. Take the most recently ENDED, and say so. Drawn from `begun`
  // for the same reason as above — a not-yet-started term is not a past one.
  const closed = byStart(begun)
  return closed ? { statement: closed, stale: true } : { stale: false }
}

/** The start date of a statement, day precision only. */
export const startedOn = (statement: Snak | undefined): string | undefined =>
  statement ? dayPrecision(timeOf(statement, 'P580')) : undefined

/** Ids from statements that have not ended — grouping membership is a
 *  relationship a party LEAVES, and an ended statement records that it used to
 *  belong, which is not what "member of the EPP" means. */
export const openClaimIds = (entity: WikidataEntity | undefined, property: string): string[] =>
  (entity?.claims?.[property] ?? [])
    .filter(statement => !statement.qualifiers?.P582?.length)
    .map(claimId)
    .filter((id): id is string => !!id)

export const labelOf = (entity: WikidataEntity | undefined): string | undefined =>
  entity?.labels?.en?.value

export const enwikiTitle = (entity: WikidataEntity | undefined): string | undefined =>
  entity?.sitelinks?.enwiki?.title

/** Comparable name tokens: lowercased, unaccented, punctuation dropped. */
const nameTokens = (value: string): string[] =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2)

/**
 * A person's name, with the article title as a check on a vandalised label.
 *
 * The label is the right field and is used wherever the two agree. But a label
 * is one edit away from anything, and the sitelink is not: it is the title of a
 * real article, so replacing it means moving a page.
 *
 * The test is whether the two share ANY word. Measured across all 319 leaders:
 * 57 differ, and almost all of those are spelling — "Lukashenka"/"Lukashenko",
 * "Poudel"/"Paudel", a dropped accent, an added "Pope". Those keep the label.
 * Exactly FOUR are wholly disjoint, and on every one the sitelink is the better
 * answer:
 *
 *   Q5441662   "Ben Do"          -> "Feleti Teo"            (vandalised)
 *   Q123342092 "Edeupa Yerimin"  -> "Russell Dlamini"       (vandalised)
 *   Q200881    "Qasym-Zhomart Toqaev" -> "Kassym-Jomart Tokayev"
 *   Q120965176 "Omar Tiani"      -> "Abdourahamane Tchiani"
 *
 * The last two are transliterations where the article title is the more
 * standard spelling, so nothing is lost by preferring it there either.
 *
 * A parenthetical disambiguator is dropped — "Ali Khamenei (politician)" is a
 * filing convention, not part of the name.
 */
export const personName = (entity: WikidataEntity | undefined): string | undefined => {
  const label = labelOf(entity)
  const title = enwikiTitle(entity)?.replace(/\s*\([^)]*\)\s*$/, '')
  if (!label) return title
  if (!title) return label
  // A name ending on a connecting particle was cut off mid-way: Qatar's emir
  // reads "Tamim bin Hamad Al" where the article title carries the missing
  // "Thani". The particle is meaningless in final position, so this cannot fire
  // on a complete name.
  if (/\s(?:al|el|bin|bint|ibn|de|del|van|von|ben)$/i.test(label.trim())) return title
  const shared = nameTokens(label).some(token => nameTokens(title).includes(token))
  return shared ? label : title
}

// ---------------------------------------------------------------------------
// Wikipedia
// ---------------------------------------------------------------------------

export interface PageRevision {
  title: string
  revid: number
  wikitext: string
}

/** An article's current wikitext and revision id. */
export const getArticle = async (title: string): Promise<PageRevision | undefined> => {
  const url =
    `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}` +
    `&prop=wikitext|revid&format=json&redirects=1`
  const data = await fetchJson<{
    parse?: { title?: string; revid?: number; wikitext?: { '*'?: string } }
  }>(url)
  const wikitext = data?.parse?.wikitext?.['*']
  if (!wikitext) return undefined
  return { title: data?.parse?.title ?? title, revid: data?.parse?.revid ?? 0, wikitext }
}

/**
 * An article's infobox as RENDERED text, with templates expanded.
 *
 * Some chambers write their seat counts as template lookups rather than
 * numbers: Mexico's `{{MexDep|MRN}}` and Indonesia's `{{DPR RI|GOLKAR}}` are
 * both real, and the wikitext carries no digit at all for a reader — or a
 * model — to find. Wikipedia renders them, so the rendered page is where those
 * chambers' compositions actually exist.
 *
 * Used only as a FALLBACK: wikitext is preferred everywhere it carries the
 * numbers, because the markup's bold headers make the government/opposition
 * split far clearer than the stripped HTML does.
 */
export const getRenderedInfobox = async (title: string): Promise<string | undefined> => {
  const url =
    `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}` +
    `&prop=text&section=0&format=json&redirects=1`
  const data = await fetchJson<{ parse?: { text?: { '*'?: string } } }>(url)
  const html = data?.parse?.text?.['*']
  if (!html) return undefined

  // Start a little BEFORE the heading. Indonesia's infobox opens its groups
  // with a coalition banner that sits above the label, and slicing at the
  // heading cut the government block off entirely — leaving a list that began
  // mid-opposition and read as illegible.
  const start = html.search(/Political groups/i)
  if (start < 0) return undefined
  return html
    .slice(Math.max(0, start - 600), start + 11000)
    // Keep link targets: they are the Q-id resolution key, and stripping tags
    // outright would throw away every party's article title.
    .replace(/<a\b[^>]*href="\/wiki\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const target = decodeURIComponent(String(href).replace(/_/g, ' '))
      const label = String(text).replace(/<[^>]+>/g, '').trim()
      return label ? `[[${target}|${label}]]` : `[[${target}]]`
    })
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(?:li|tr|div|p)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Last-edit timestamps for many titles in one request — the cheap change probe. */
export const lastEdited = async (titles: string[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>()
  for (let index = 0; index < titles.length; index += 40) {
    const batch = titles.slice(index, index + 40)
    const url =
      `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=timestamp` +
      `&titles=${encodeURIComponent(batch.join('|'))}&format=json&redirects=1`
    const data = await fetchJson<{
      query?: { pages?: Record<string, { title?: string; revisions?: { timestamp?: string }[] }> }
    }>(url, 60 * 60 * 1000)
    for (const page of Object.values(data?.query?.pages ?? {})) {
      if (page.title && page.revisions?.[0]?.timestamp) out.set(page.title, page.revisions[0].timestamp)
    }
  }
  return out
}

export interface FileLicence {
  license?: string
  credit?: string
  non_free: boolean
  restrictions?: ImageRestriction[]
  host: 'commons' | 'wikipedia'
}

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * A file's licence, from whichever wiki hosts it.
 *
 * Commons hosting was long used as the licence test itself. That is sound one
 * way and wrong the other: a freely licensed file uploaded to en.wikipedia
 * instead fails a hosting probe while being perfectly free — South Africa's
 * Democratic Alliance mark is public domain and lives there. So ask the
 * licence, and let the consumer decide on the answer.
 */
/**
 * Fold Commons' licence spellings onto one name each.
 *
 * The same licence arrives under several short names — "PD" and "Public
 * domain", "Attribution" and "CC BY", "CC BY 3.0 cl" for the Chilean port —
 * which made thirteen distinct values out of about eight real licences and put
 * an enum out of reach. Versions ARE kept apart, because CC BY-SA 3.0 and 4.0
 * are genuinely different terms.
 */
const normaliseLicence = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined
  const value = raw.trim()
  if (/^(pd|public domain)\b/i.test(value)) return 'Public domain'
  if (/^fair use\b/i.test(value)) return 'Fair use'
  if (/^cc0\b/i.test(value)) return 'CC0'
  if (/^attribution$/i.test(value)) return 'CC BY'
  // "CC BY-SA 3.0 de", "CC BY 3.0 cl" — a jurisdiction port of the same terms.
  const cc = /^(cc by(?:-sa)?)\s*([\d.]+)?/i.exec(value)
  if (cc) return `${cc[1]!.toUpperCase().replace('CC BY', 'CC BY')}${cc[2] ? ` ${cc[2]}` : ''}`
  return value
}

/**
 * Commons' pipe-joined restriction list, as its parts.
 *
 * Values outside the known set are DROPPED rather than passed through, so the
 * published field is a closed vocabulary a consumer can switch on. A new value
 * appearing upstream is a deliberate addition to `IMAGE_RESTRICTIONS`, not a
 * surprise in the data.
 */
const restrictionList = (raw: string | undefined): ImageRestriction[] => {
  if (!raw) return []
  const parts = raw.split('|').map(part => part.trim().toLowerCase())
  const known = parts.filter((part): part is ImageRestriction =>
    (IMAGE_RESTRICTIONS as readonly string[]).includes(part)
  )
  return [...new Set(known)].sort()
}

export const fileLicence = async (file: string): Promise<FileLicence | undefined> => {
  for (const host of ['commons', 'wikipedia'] as const) {
    const domain = host === 'commons' ? 'commons.wikimedia.org' : 'en.wikipedia.org'
    const url =
      `https://${domain}/w/api.php?action=query&prop=imageinfo&iiprop=extmetadata` +
      `&titles=${encodeURIComponent(`File:${file}`)}&format=json`
    const data = await fetchJson<{
      query?: {
        pages?: Record<
          string,
          {
            imageinfo?: {
              extmetadata?: Record<string, { value?: string }>
            }[]
          }
        >
      }
    }>(url)
    const meta = Object.values(data?.query?.pages ?? {})[0]?.imageinfo?.[0]?.extmetadata
    if (!meta) continue
    const license = normaliseLicence(
      meta.LicenseShortName?.value ? stripTags(meta.LicenseShortName.value) : undefined
    )
    const credit = meta.Artist?.value ? stripTags(meta.Artist.value) : undefined
    return {
      ...(license ? { license } : {}),
      ...(credit ? { credit: credit.slice(0, 120) } : {}),
      non_free: String(meta.NonFree?.value ?? '').toLowerCase() === 'true',
      // Commons joins multiple restrictions with a pipe — "insignia|communist".
      // An array says the same thing without every consumer having to know the
      // separator, and the values are a closed set worth validating.
      ...(restrictionList(meta.Restrictions?.value).length
        ? { restrictions: restrictionList(meta.Restrictions?.value) }
        : {}),
      host,
    }
  }
  return undefined
}

export const filePathUrl = (file: string, host: 'commons' | 'wikipedia'): string => {
  const domain = host === 'commons' ? 'commons.wikimedia.org' : 'en.wikipedia.org'
  return `https://${domain}/wiki/Special:FilePath/${encodeURIComponent(file)}`
}
