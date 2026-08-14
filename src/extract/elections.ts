import { fetchJson } from '../net/wiki'

/**
 * Has an election happened that our composition does not describe?
 *
 * A single pass over a chamber's article cannot answer this. It reads one page
 * and has nothing to compare against, so a country whose parliament was
 * re-elected last month looks exactly like one whose parliament was re-elected
 * four years ago — Ethiopia voted in June 2026 and the dataset still described
 * its 2021 chamber, because the article it read had not been updated.
 *
 * So this is a SECOND, cheap step. Wikipedia names election articles by a
 * strong convention — "2026 Ethiopian general election", "2026 Guinean
 * parliamentary election" — and asking whether such a page EXISTS is one
 * batched query for a whole year of countries. It says nothing about the
 * result; it says the composition should be distrusted, which is the part a
 * consumer needs and the part we can honestly assert.
 */

const KINDS = ['general', 'parliamentary', 'legislative', 'federal'] as const

/**
 * Candidate article titles for a country's election in a given year.
 *
 * The demonym does the work — "Ethiopian", "Guinean", "Swedish" — and a
 * country supplies it. Several phrasings are tried because the convention
 * splits on what the country calls the vote.
 */
export const electionTitles = (demonym: string, year: number): string[] =>
  KINDS.map(kind => `${year} ${demonym} ${kind} election`)

export interface ElectionSince {
  /** The article that exists, when one does. */
  article: string
  year: number
}

/**
 * An article for THIS year may describe a vote that has not happened yet.
 *
 * Sweden's "2026 Swedish general election" was written months before polling
 * day in September. Wikipedia opens these pages as soon as a date is set, so
 * existence proves a scheduled election, not a held one — and flagging a
 * sitting parliament as superseded by its own future election would be worse
 * than missing a stale one.
 *
 * A page whose year is in the past is safe. For the current year the page has
 * to say the result is in, which it does by carrying seat counts.
 */
const hasResults = async (article: string): Promise<boolean> => {
  const url =
    `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(article)}` +
    `&prop=wikitext&format=json&redirects=1`
  const data = await fetchJson<{ parse?: { wikitext?: { '*'?: string } } }>(url)
  const wikitext = data?.parse?.wikitext?.['*'] ?? ''
  // An election infobox only carries seat counts once there are seats to count.
  return /\|\s*seats\d*\s*=\s*\d/.test(wikitext) || /\|\s*seats_after\d*\s*=\s*\d/.test(wikitext)
}

/**
 * The most recent election article that exists AFTER a given date.
 *
 * Checked in one batched request per year, newest first, and stopping at the
 * first hit: a country that voted in 2026 makes its 2025 article irrelevant.
 */
export const electionSince = async (
  demonym: string,
  after: string | undefined,
  now = new Date()
): Promise<ElectionSince | undefined> => {
  if (!demonym) return undefined
  const from = after ? Number(after.slice(0, 4)) : now.getFullYear() - 1
  // Only years that have actually arrived. Wikipedia opens articles for
  // elections years ahead — Lebanon's 2028 general election has a page today —
  // and treating one as superseding a sitting parliament would be nonsense.
  const years: number[] = []
  for (let year = now.getFullYear(); year > from; year--) years.push(year)
  if (!years.length) return undefined

  const titles = years.flatMap(year => electionTitles(demonym, year))
  // 50 titles is the API's ceiling and comfortably more than four years' worth.
  for (let index = 0; index < titles.length; index += 45) {
    const batch = titles.slice(index, index + 45)
    const url =
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(batch.join('|'))}` +
      `&format=json&redirects=1`
    const data = await fetchJson<{
      query?: { pages?: Record<string, { title?: string; missing?: string }> }
    }>(url, 24 * 60 * 60 * 1000)
    const found = Object.values(data?.query?.pages ?? {})
      .filter(page => page.missing === undefined && page.title)
      .map(page => page.title!)
    if (!found.length) continue
    // Newest year among the hits.
    const best = found
      .map(title => ({ title, year: Number(/^(\d{4})/.exec(title)?.[1] ?? 0) }))
      .filter(hit => hit.year > from && hit.year <= now.getFullYear())
      .sort((a, b) => b.year - a.year)[0]
    if (!best) continue
    // A future-dated article is not a held election.
    if (best.year >= now.getFullYear() && !(await hasResults(best.title))) continue
    return { article: best.title, year: best.year }
  }
  return undefined
}
