import { hashOf } from '../net/cache'
import { getArticle, getRenderedInfobox, type PageRevision } from '../net/wiki'
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

/**
 * A seat count: parentheses around a number and nothing else.
 *
 * A four-digit number is excluded because it is almost always a YEAR — a
 * party's disambiguator, as in Indonesia's "Prosperous Justice Party (2020)",
 * which made the field look as though it carried counts when every real count
 * in it was an unexpanded template. No chamber seats between 1000 and 9999
 * members, so nothing true is lost.
 */
const SEAT_COUNT = /\(\s*(?!\d{4}\s*\))\d[\d,]*\s*\)/

/**
 * Whether a field's seat counts are mostly template lookups.
 *
 * Counted per BULLET, since each bullet is one party and should carry one
 * number. Indonesia writes every government party as `{{DPR RI|GOLKAR}}` and
 * one opposition bloc as a literal `(110)`, so testing for "no numbers at all"
 * kept the whole chamber on markup the model could not read. Half or fewer
 * resolved means the rendered page is the better source.
 */
const mostlyTemplated = (field: string): boolean => {
  if (!/\{\{/.test(field)) return false
  const bullets = (field.match(/^\s*[*:]/gm) ?? []).length
  if (bullets < 2) return false
  // A seat count is a number in parentheses OR the last argument of a legend
  // template. India writes every row as `{{Party legend|Indian National
  // Congress|98}}` — the number is there, plainly, behind a pipe rather than a
  // bracket. Counting only parentheses saw 8 counts against 45 bullets, sent
  // the country down the rendered-HTML path, and spent the model's window on
  // inline CSS instead of parties.
  const counts =
    (field.match(new RegExp(SEAT_COUNT.source, 'g')) ?? []).length +
    (field.match(/\{\{\s*(?:party legend|legend|composition bar)[^}]*\|\s*\d[\d,]*\s*[|}]/gi) ?? [])
      .length
  // A template that looks up its number elsewhere carries no digit at all —
  // Ireland writes `{{Political party data|seats|Q216517|ms-lower-house}}`,
  // which resolves against Wikidata at render time. Those are the clearest
  // possible case for reading the rendered page instead.
  const lookups = (field.match(/\{\{\s*(?:political party data|party data)\b/gi) ?? []).length
  if (lookups >= 2) return true
  return counts <= bullets / 2
}

/**
 * Only the fields that mean an ELECTION.
 *
 * `election1`…`electionN` are the dates the numbered LEADERS took their posts —
 * a speaker's, a whip's, a party leader's. Canada carries five of them, and
 * offering the model `election5 = September 13, 2022` alongside the real
 * `last_election1 = April 28, 2025` got the leadership date reported as the
 * chamber's last election, three years wrong.
 */
const ELECTION_FIELDS = /^\s*\|\s*(?:last_election\d*|next_election\d*)\s*=\s*(.+)$/gim

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
    // A field whose seat counts are all template lookups carries no number a
    // reader can see — Mexico writes `{{MexDep|MRN}}`, Indonesia
    // `{{DPR RI|GOLKAR}}`. The rendered page expands them, so that is where
    // those chambers' compositions actually live.
    // Prefer the RENDERED page when most of the seat counts are template
    // lookups rather than numbers.
    //
    // "No numbers at all" was too strict a test: Indonesia writes every
    // government party as `{{DPR RI|GOLKAR}}` and then one opposition bloc as a
    // literal `(110)`, so a single hardcoded figure kept the whole chamber on
    // unexpanded markup the model could not read. What matters is the RATIO —
    // a field whose bullets outnumber its counts is one where the numbers live
    // in the templates.
    if (mostlyTemplated(field)) {
      const rendered = await getRenderedInfobox(articleTitle)
      if (rendered && SEAT_COUNT.test(rendered)) {
        const elections = electionLines(page.wikitext)
        return {
          text: elections ? `${rendered.slice(0, 11000)}\n\n${elections}` : rendered.slice(0, 12000),
          hash: hashOf(rendered),
          precise: true,
          article: page.title,
          revid: page.revid,
          ...(elections ? { elections } : {}),
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
