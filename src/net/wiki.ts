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

export const resolveStatement = (statements: Snak[] | undefined): Resolution => {
  const live = (statements ?? []).filter(statement => statement.rank !== 'deprecated')
  const byStart = (pool: Snak[]) =>
    [...pool].sort((a, b) => (timeOf(b, 'P580') ?? '').localeCompare(timeOf(a, 'P580') ?? ''))[0]

  const open = live.filter(statement => !statement.qualifiers?.P582?.length)
  if (open.length) {
    const preferred = open.filter(statement => statement.rank === 'preferred')
    const chosen = byStart(preferred.length ? preferred : open)
    return chosen ? { statement: chosen, stale: false } : { stale: false }
  }
  // Nothing open. Take the most recently ENDED, and say so.
  const closed = byStart(live)
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
  restrictions?: string
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
    const license = meta.LicenseShortName?.value ? stripTags(meta.LicenseShortName.value) : undefined
    const credit = meta.Artist?.value ? stripTags(meta.Artist.value) : undefined
    return {
      ...(license ? { license } : {}),
      ...(credit ? { credit: credit.slice(0, 120) } : {}),
      non_free: String(meta.NonFree?.value ?? '').toLowerCase() === 'true',
      ...(meta.Restrictions?.value ? { restrictions: meta.Restrictions.value } : {}),
      host,
    }
  }
  return undefined
}

export const filePathUrl = (file: string, host: 'commons' | 'wikipedia'): string => {
  const domain = host === 'commons' ? 'commons.wikimedia.org' : 'en.wikipedia.org'
  return `https://${domain}/wiki/Special:FilePath/${encodeURIComponent(file)}`
}
