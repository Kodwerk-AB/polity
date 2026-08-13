import { hashOf } from '../net/cache'
import { getArticle, type PageRevision } from '../net/wiki'
import {
  compositionField,
  legislatureInfobox,
  switchBranch,
  transcludedTemplate,
} from './composition'

/**
 * The markup a chamber's composition actually lives in, following one level of
 * transclusion.
 *
 * A composition field is usually the parties themselves. Sometimes it is a
 * pointer: Britain writes `{{UK Parliament political groups|Commons}}` and
 * keeps both houses in one template behind a `#switch`. Reading only the field
 * loses the country entirely, so the pointer is followed — once, never
 * recursively, because a second hop has never been needed and an unbounded
 * follow would wander into the template ecosystem.
 */

export interface ChamberSource {
  text: string
  hash: string
  precise: boolean
  article: string
  revid: number
  /**
   * The infobox's election-date fields, appended to what the model reads.
   *
   * They sit OUTSIDE the composition field, so the field alone never carries
   * them — but they are what makes a stale composition detectable, and asking
   * for them costs nothing when the model is already reading the page.
   * Deliberately not part of `hash`: a scheduled date moving is not a change of
   * composition, and re-extracting every chamber when one does would defeat the
   * gate.
   */
  elections?: string
}

const ELECTION_FIELDS =
  /^\s*\|\s*(?:last_election\d*|next_election\d*|election\d*|new_session)\s*=\s*(.+)$/gim

const electionLines = (wikitext: string): string | undefined => {
  const lines = [...wikitext.matchAll(ELECTION_FIELDS)]
    .map(match => match[0].trim())
    .filter(line => line.length < 220)
  return lines.length ? lines.slice(0, 6).join('\n') : undefined
}

export const chamberSource = async (
  articleTitle: string
): Promise<ChamberSource | undefined> => {
  const page: PageRevision | undefined = await getArticle(articleTitle)
  if (!page) return undefined

  const field = compositionField(page.wikitext)
  if (field) {
    const pointer = transcludedTemplate(field)
    if (pointer) {
      const template = await getArticle(pointer.title)
      const body = template
        ? (pointer.parameter ? switchBranch(template.wikitext, pointer.parameter) : undefined) ??
          template.wikitext
        : undefined
      if (body && body.length > 40) {
        const elections = electionLines(page.wikitext)
        return {
          text: elections ? `${body.slice(0, 11000)}\n\n${elections}` : body.slice(0, 12000),
          // Hash the TEMPLATE body, since that is what changes when the
          // composition does — the field itself is a constant pointer.
          hash: hashOf(body),
          precise: true,
          article: page.title,
          revid: page.revid,
        }
      }
    }
    const elections = electionLines(page.wikitext)
    return {
      text: elections ? `${field}\n\n${elections}` : field,
      hash: hashOf(field),
      precise: true,
      article: page.title,
      revid: page.revid,
      ...(elections ? { elections } : {}),
    }
  }

  const box = legislatureInfobox(page.wikitext)
  if (box) {
    return { text: box, hash: hashOf(box), precise: false, article: page.title, revid: page.revid }
  }
  return undefined
}
