import { hashOf } from '../net/cache'

/**
 * The `political_groups1` field, isolated from a legislature article.
 *
 * This field is the whole reason the pipeline reads Wikipedia at all. Measured
 * across 20 legislature articles, 19 carry it, and it holds what no structured
 * source publishes: every seated bloc, its seat count, AND the government /
 * opposition split, written as bold headers.
 *
 * It is also the change-detection key. Measured across six busy articles and
 * 120 revisions spanning 11–168 days, this field never changed once, while 18
 * of 20 pages were edited within 90 days. So the hash of THIS, not of the page,
 * is what decides whether a model is invoked.
 */

const FIELD_NAMES = ['political_groups1', 'political_groups', 'political_groups2'] as const

/**
 * The raw field value, from `|name =` to the next top-level `|field =`.
 *
 * Deliberately NOT brace-aware. The value is full of templates — `{{Composition
 * bar}}`, `{{colour box}}`, `{{collapsible list}}` — and a brace-balanced read
 * would be the right way to take ONE template, where here the whole remainder
 * is wanted and handed to a model that copes with the markup.
 */
/**
 * The value of `|field =`, read to the next TOP-LEVEL field.
 *
 * Brace-aware, and that is the whole point. A naive "stop at the next
 * `\n| something =`" is wrong wherever the value contains templates that carry
 * pipes of their own, which is most of them: Brazil's Chamber wraps its parties
 * in `{{efn|…}}` footnotes, and the regex terminated inside the first one —
 * returning 662 characters of the government bloc and cutting all 351 seats of
 * the opposition. Italy and South Africa were truncated the same way.
 *
 * So the depth of `{{`/`[[` is tracked, and a `|` only ends the value at depth
 * zero. The cursor advances by two over a brace pair so an overlapping run like
 * `}}}}` is counted once per pair rather than once per position.
 */
const valueOf = (wikitext: string, field: string): string | undefined => {
  const opener = new RegExp(`^\\s*\\|\\s*${field}\\s*=`, 'im')
  const match = opener.exec(wikitext)
  if (!match) return undefined

  let cursor = match.index + match[0].length
  const start = cursor
  let depth = 0
  while (cursor < wikitext.length) {
    const pair = wikitext.slice(cursor, cursor + 2)
    if (pair === '{{' || pair === '[[') {
      depth += 1
      cursor += 2
      continue
    }
    if (pair === '}}' || pair === ']]') {
      depth = Math.max(0, depth - 1)
      cursor += 2
      continue
    }
    if (depth === 0) {
      // A top-level `|` at the start of a line is the next field; `}}` there
      // closes the infobox itself.
      if (/^\n\s*\|\s*[a-z_0-9]+\s*=/i.test(wikitext.slice(cursor, cursor + 40))) break
      if (wikitext.startsWith('\n}}', cursor)) break
    }
    cursor += 1
  }
  return wikitext.slice(start, cursor).trim()
}

export const compositionField = (wikitext: string): string | undefined => {
  for (const field of FIELD_NAMES) {
    const value = valueOf(wikitext, field)
    if (value && value.length > 8) return value
  }
  return undefined
}

/** The whole infobox, for the cases where the field is missing but the box has
 *  seats elsewhere — the model gets more to work with and says so. */
export const legislatureInfobox = (wikitext: string): string | undefined => {
  const start = wikitext.search(/\{\{\s*Infobox\s+legislature/i)
  if (start < 0) return undefined
  return wikitext.slice(start, start + 9000)
}

/**
 * The template a composition field defers to, when it defers to one.
 *
 * Britain writes `|political_groups1 = {{UK Parliament political groups|Commons}}`
 * and keeps the actual parties in the template, so the field alone reads as
 * fourteen characters of nothing. The template is a real page and can be
 * fetched; the switch parameter says which chamber's block to read.
 */
export const transcludedTemplate = (
  field: string
): { title: string; parameter?: string } | undefined => {
  const match = /^\s*\{\{\s*([^|}]+?)\s*(?:\|\s*([^|}]+?)\s*)?\}\}\s*$/.exec(field)
  const name = match?.[1]
  if (!name || /^(plainlist|ubl|unbulleted list|composition bar|colou?r box)$/i.test(name)) {
    return undefined
  }
  const parameter = match?.[2]
  return { title: name.startsWith('Template:') ? name : `Template:${name}`, ...(parameter ? { parameter } : {}) }
}

/**
 * One branch of a `{{#switch:}}` template — the block for a named chamber.
 *
 * Britain's template holds Commons and Lords in one page behind a switch, and
 * taking the whole page would hand the model both houses at once.
 */
export const switchBranch = (wikitext: string, parameter: string): string | undefined => {
  const opener = new RegExp(`<includeonly>\\s*${parameter}\\s*=</includeonly>`, 'i')
  const match = opener.exec(wikitext)
  if (!match) return undefined
  // Start AFTER the branch's own header, or the terminator search matches it
  // immediately and returns the whole remaining template — both houses at once.
  const from = match.index + match[0].length
  const rest = wikitext.slice(from)
  const end = rest.search(/\|?\s*<includeonly>\s*[A-Za-z]+\s*=<\/includeonly>/i)
  return (end > 0 ? rest.slice(0, end) : rest).trim()
}

export interface CompositionSource {
  /** What the model is given. */
  text: string
  /** Hash of the composition field alone — the invocation gate. */
  hash: string
  /** True when the composition field was found; false when the whole infobox
   *  is being used as a fallback and the reading is less certain. */
  precise: boolean
}

export const compositionSource = (wikitext: string): CompositionSource | undefined => {
  const field = compositionField(wikitext)
  if (field) return { text: field, hash: hashOf(field), precise: true }
  const box = legislatureInfobox(wikitext)
  if (box) return { text: box, hash: hashOf(box), precise: false }
  return undefined
}
