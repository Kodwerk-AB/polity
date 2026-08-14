import { IDEOLOGY_FAMILIES, type IdeologyFamily } from '../types/enums'
import type { QID } from '../types/polity'

/**
 * The families a party's ideologies belong to, deduplicated.
 *
 * A party commonly spans several — "social democracy" and "green politics"
 * together, or "conservatism" and "nationalism" — and all are reported, because
 * collapsing to one would be a judgement the source does not support.
 *
 * `byQid` is the classification map, built once per run by `classifyIdeologies`
 * and cached per ideology — so a rebuild classifies only what is new.
 */
export const familiesOf = (
  ideologies: { qid: QID }[],
  byQid: Record<string, IdeologyFamily>
): IdeologyFamily[] => {
  const found = new Set<IdeologyFamily>()
  for (const ideology of ideologies) {
    const family = byQid[ideology.qid]
    if (family) found.add(family)
  }
  // `other` only where a party HAS ideologies and none of them placed — never
  // as a stand-in for "we know nothing", which is an empty array.
  if (!found.size && ideologies.length) found.add('other')
  return [...found].sort(
    (a, b) => IDEOLOGY_FAMILIES.indexOf(a) - IDEOLOGY_FAMILIES.indexOf(b)
  )
}
