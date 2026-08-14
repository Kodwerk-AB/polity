import { getArticle } from '../net/wiki'

/**
 * The leaders named in a country's OWN article infobox.
 *
 * A third source, and the freshest of the three. Wikidata's country item
 * records who arrived and often never records who left; the office item is
 * maintained for some countries and abandoned for others. The country article
 * is the most-watched page a country has — measured across twelve states
 * including every one that was wrong, it had been edited within four days, and
 * it carried the correct current leader in every case.
 *
 * It is the only source that had Chad's Allamaye Halina and Iraq's Nizar Amidi,
 * both of which the structured routes miss by years.
 *
 * Returned as RAW TEXT for the model to read, not parsed here: the fields are
 * full of the things a human writes and a regex cannot survive — Somalia's
 * carries a stray `quote=`, Sudan's reads "Disputed by Hemedti of the RSF",
 * Burkina Faso lists the same man twice under two titles.
 */
export interface LeaderLines {
  text: string
  article: string
  revid: number
}

/**
 * The country article's own `government_type`, verbatim.
 *
 * The source that answers what Wikidata's P122 cannot. P122 returns NOTHING for
 * 39 countries and a bare "republic" for 21 more, which is why a third of the
 * dataset falls to `form: other`. This field is prose, maintained on the most
 * watched page a country has, and it says the part that matters:
 *
 *   Mali    — "Unitary presidential republic under a military junta"
 *   Eritrea — "one-party presidential republic under a totalitarian dictatorship"
 *   Cameroon— "presidential republic under an authoritarian dictatorship"
 *   Djibouti— "presidential republic under a hereditary dictatorship"
 *
 * Every one of those was `other` on the structured route.
 */
export const governmentTypeLine = async (articleTitle: string): Promise<string | undefined> => {
  const page = await getArticle(articleTitle)
  const raw = /^\s*\|\s*government_type\s*=\s*(.+)$/im.exec(page?.wikitext ?? '')?.[1]
  if (!raw) return undefined
  const text = raw
    .replace(/<ref[\s\S]*$/i, '')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 3 ? text.slice(0, 200) : undefined
}

const LEADER_FIELDS = /^\s*\|\s*(?:leader_title\d*|leader_name\d*)\s*=\s*(.+)$/gim

export const leaderLines = async (articleTitle: string): Promise<LeaderLines | undefined> => {
  const page = await getArticle(articleTitle)
  if (!page) return undefined
  const lines = [...page.wikitext.matchAll(LEADER_FIELDS)]
    .map(match => match[0].trim())
    .filter(line => line.length < 200)
  if (lines.length < 2) return undefined
  return { text: lines.slice(0, 12).join('\n'), article: page.title, revid: page.revid }
}
