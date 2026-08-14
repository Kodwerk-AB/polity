import { cacheRead, cacheWrite } from '../net/cache'

/**
 * V-Dem's electoral democracy index, as an outside check on our own arithmetic.
 *
 * `contestation` is otherwise derived from seat concentration, and that measure
 * has one blind spot it cannot close by itself: a LANDSLIDE and a RIGGED BALLOT
 * are numerically identical. Barbados' governing party won all 30 seats in 2022
 * in an election nobody disputes; Turkmenistan's wins everything too. Seat
 * counts say the same thing about both, so the rule called Barbados
 * `uncontested`.
 *
 * V-Dem measures the thing the seats cannot show — whether the contest was
 * real. Barbados scores 0.797 and Turkmenistan 0.148, which is the separation
 * the arithmetic is missing.
 *
 * Taken from Our World in Data's mirror rather than v-dem.net, whose own
 * download sits behind a registration form. OWID republishes the same series
 * under CC-BY with ISO-3166 alpha-3 codes already attached, and it is the route
 * this project's sibling already uses.
 */

const SOURCE =
  'https://ourworldindata.org/grapher/electoral-democracy-index.csv' +
  '?v=1&csvType=full&useColumnShortNames=true'

/** A week. The series is annual; nothing is gained by fetching it more often. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface DemocracyScore {
  /** 0–1. Higher is a freer contest. */
  score: number
  /** The year the score describes. */
  year: number
}

/**
 * Latest score per ISO-3166 alpha-3 code.
 *
 * One request for every country, cached, so this costs nothing per chamber.
 */
const loadScores = async (): Promise<Record<string, DemocracyScore>> => {
  const key = 'vdem:electoral-democracy'
  const cached = cacheRead<Record<string, DemocracyScore>>(key, TTL_MS)
  if (cached) return cached

  const response = await fetch(SOURCE, {
    headers: { 'user-agent': 'polity (https://github.com/Kodwerk-AB/polity)' },
  })
  if (!response.ok) return {}
  const text = await response.text()

  const lines = text.split('\n')
  const header = lines[0]?.split(',') ?? []
  const codeAt = header.indexOf('code')
  const yearAt = header.indexOf('year')
  // The value column carries the indicator's own name, which moves between
  // vintages — so it is found by position rather than by a literal we would
  // have to chase. It is the one numeric column that is neither code nor year.
  const valueAt = header.findIndex(
    (name, index) =>
      index !== codeAt && index !== yearAt && /electdem|polyarchy/i.test(name)
  )
  if (codeAt < 0 || yearAt < 0 || valueAt < 0) return {}

  const latest: Record<string, DemocracyScore> = {}
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    const code = cells[codeAt]
    // Regions and aggregates carry no alpha-3 code; only countries do.
    if (!code || code.length !== 3) continue
    const year = Number(cells[yearAt])
    const score = Number(cells[valueAt])
    if (!Number.isFinite(year) || !Number.isFinite(score)) continue
    const held = latest[code]
    if (!held || year > held.year) latest[code] = { score, year }
  }

  cacheWrite(key, latest)
  return latest
}

let scores: Record<string, DemocracyScore> | undefined

/**
 * A country's score, or `undefined` where V-Dem does not cover it.
 *
 * Coverage is 176 of the 193 UN members — the omissions are small states
 * (Antigua, Belize, Saint Lucia, Monaco, most of the Pacific). Absence carries
 * NO implication about the country: it must never be read as a low score, which
 * is why this returns `undefined` rather than a default.
 */
export const democracyScore = async (
  alpha3: string | undefined
): Promise<DemocracyScore | undefined> => {
  if (!alpha3) return undefined
  scores ??= await loadScores()
  return scores[alpha3.toUpperCase()]
}

/**
 * The score above which a chamber the arithmetic condemned is given back.
 *
 * Deliberately high, and deliberately used in ONE direction only.
 *
 * The bands overlap in the middle: Senegal (0.633) and Guatemala (0.637) are
 * competitive, while Kenya (0.563) and the Maldives (0.556) sit just below them
 * and Singapore (0.434) below that. No cut sorts those correctly, so a middling
 * score is treated as no evidence at all rather than as evidence against. Only
 * an unambiguous score — Barbados at 0.797, Mauritius at 0.738 — overrides what
 * we observed.
 */
export const FREE_ELECTION_SCORE = 0.7
