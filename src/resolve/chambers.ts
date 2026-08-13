import {
  claimAmount,
  claimIds,
  currentStatement,
  enwikiTitle,
  getEntities,
  labelOf,
  type WikidataEntity,
} from '../net/wiki'
import type { ChamberRole } from '../types/enums'
import type { QID } from '../types/polity'

/**
 * Country → its chambers, resolved from the Wikidata graph alone.
 *
 * The naive route — `P194` then match `P31` against `Q375928` — resolves 25 of
 * 40 countries. It fails because "lower house" is not one class: Australia's
 * House of Representatives is `Q2145277`, Brazil's Chamber of Deputies
 * `Q320289`, Britain's and Canada's Commons `Q9247597`. All of them SUBCLASS to
 * `Q375928`, so walking `P279` upward resolves what exact matching cannot.
 *
 * `P194` also lies about arity: it returns the bicameral parent for Germany
 * (the Bundesrat first), four values for France including "Congress of the
 * French Parliament", and a defunct Soviet body for Russia. So every candidate
 * is classified, dissolved ones are dropped, and the result is a SET of roles
 * rather than an assumption of one.
 */

const LOWER_HOUSE = 'Q375928'
const UPPER_HOUSE = 'Q637846'
const UNICAMERAL = 'Q37002670'
const BICAMERAL = 'Q189445'
const ROLE_ROOTS: Record<string, ChamberRole> = {
  [LOWER_HOUSE]: 'lower',
  [UPPER_HOUSE]: 'upper',
  [UNICAMERAL]: 'unicameral',
}

export interface ChamberRef {
  qid: QID
  role: ChamberRole
  name: string
  /**
   * The chamber's name in its own language — "Bundestag", "Sejm",
   * "Asamblea Legislativa", "최고인민회의".
   *
   * From P1705 (native label), which is the chamber's own name for itself
   * rather than a translation. Worth carrying because it is frequently the name
   * a reader actually recognises: nobody outside Germany calls the Bundestag
   * the Federal Diet, and "Riksdag" is more use than "Parliament of Sweden".
   */
  name_local?: string
  article?: string
  /** P1342 at preferred rank — the chamber's declared size. */
  seats_total?: number
  /** P2097 — the constitutional term, in years. */
  term_years?: number
  /** Set when the class hierarchy did not name a role and one was inferred. */
  inferred: boolean
  /** The body is abolished or suspended and is not currently sitting. */
  dissolved?: boolean
}

/**
 * Walk `P279` upward from a set of classes, collecting everything reachable.
 *
 * Bounded by depth and by a visited set: Wikidata's class graph has cycles, and
 * an unbounded walk on `organization` reaches most of the ontology.
 */
const superclassesOf = async (classIds: string[], depth = 3): Promise<Set<string>> => {
  const reached = new Set<string>(classIds)
  let frontier = classIds
  for (let level = 0; level < depth && frontier.length; level++) {
    const entities = await getEntities(frontier, 'claims')
    const next: string[] = []
    for (const id of frontier) {
      for (const parent of claimIds(entities[id], 'P279')) {
        if (reached.has(parent)) continue
        reached.add(parent)
        next.push(parent)
      }
    }
    frontier = next
  }
  return reached
}

/**
 * The role a chamber's own classes imply, via the subclass chain.
 *
 * `lower` and `upper` are tested BEFORE `unicameral`, and that order is the
 * whole rule. Equatorial Guinea's Chamber of People's Representatives is filed
 * as both `chamber of deputies` and `unicameral legislature` — the second being
 * a leftover from before the Senate existed. Reading it as unicameral made the
 * country look single-chambered and then, because a Senate was also found, the
 * conflict rule deleted the lower house and left only the Senate.
 *
 * Being a house of a two-house legislature is the more specific claim, so it
 * wins. `unicameral` is only believed when nothing more specific applies.
 */
const SPECIFIC_ROLES: [string, ChamberRole][] = [
  [LOWER_HOUSE, 'lower'],
  [UPPER_HOUSE, 'upper'],
]

const roleFromClasses = async (classIds: string[]): Promise<ChamberRole | undefined> => {
  for (const [root, role] of SPECIFIC_ROLES) if (classIds.includes(root)) return role
  if (classIds.includes(UNICAMERAL)) {
    // Direct unicameral class, but check the chain first: a class that also
    // reaches `lower house` or `upper house` is a house, not a whole assembly.
    const reachable = await superclassesOf(classIds)
    for (const [root, role] of SPECIFIC_ROLES) if (reachable.has(root)) return role
    return 'unicameral'
  }
  const reachable = await superclassesOf(classIds)
  for (const [root, role] of SPECIFIC_ROLES) if (reachable.has(root)) return role
  return reachable.has(UNICAMERAL) ? 'unicameral' : undefined
}

/**
 * A house whose classes say nothing useful, read from its NAME.
 *
 * Thailand's House of Representatives is typed only `Q11204` (legislature),
 * which is true of every chamber and identifies none. The naming conventions
 * are strong and worldwide — a "House of Representatives" is a lower house
 * wherever it sits — so this recovers the chamber rather than losing the
 * country. Applied ONLY when the class hierarchy has already failed.
 */
const LOWER_NAMES =
  /\b(house of representatives|chamber of deputies|house of commons|national assembly|legislative assembly|people'?s assembly|chamber of people)\b/i
const UPPER_NAMES = /\b(senate|house of lords|council of states|federation council|house of federation)\b/i

/**
 * P527 lists the OFFICE of membership beside the chamber itself — "member of
 * the National Assembly of Chad". Those match the naming conventions perfectly
 * and are not chambers, so the name route must refuse them explicitly; the
 * class route never saw them because a position reaches no chamber role.
 */
const A_POSITION = /^(member|deputy|senator|speaker|president|chair)\b|\bmember of\b/i

const roleFromName = (name: string): ChamberRole | undefined => {
  if (A_POSITION.test(name)) return undefined
  return UPPER_NAMES.test(name) ? 'upper' : LOWER_NAMES.test(name) ? 'lower' : undefined
}

/** P1705 native label, or the endonym Wikidata files under P1448/P1559. */
const nativeName = (entity: WikidataEntity | undefined): string | undefined => {
  for (const property of ['P1705', 'P1448', 'P1549']) {
    const raw = entity?.claims?.[property]?.[0]?.mainsnak?.datavalue?.value
    const text = (raw as { text?: string } | undefined)?.text
    if (text && text.trim()) return text.trim()
  }
  return undefined
}

const seatsOf = (entity: WikidataEntity | undefined): number | undefined => {
  const statement = currentStatement(entity?.claims?.P1342)
  const amount = statement ? claimAmount(statement) : undefined
  return amount && amount > 0 ? amount : undefined
}

/**
 * The chamber's term of office in YEARS (P2097).
 *
 * Wikidata stores the unit as a Q-id, so a term written in months or days
 * arrives as a bare number that means something else entirely. Anything outside
 * a plausible range is dropped rather than converted — a guess about the unit
 * would produce a mandate status that is confidently wrong.
 */
const YEAR_UNIT = 'Q577'

const termFrom = (entity: WikidataEntity | undefined): number | undefined => {
  const statement = currentStatement(entity?.claims?.P2097)
  if (!statement) return undefined
  // The unit is a Q-id, so a term written in months or days arrives as a bare
  // number meaning something else entirely. Only years are trusted; anything
  // else is dropped rather than converted, because a guess about the unit
  // produces a mandate status that is confidently wrong.
  const unit = (statement.mainsnak?.datavalue?.value as { unit?: string } | undefined)?.unit
  if (unit && !unit.endsWith(YEAR_UNIT)) return undefined
  const amount = claimAmount(statement)
  return amount && amount >= 1 && amount <= 12 ? amount : undefined
}

/**
 * The chamber's term of office, in years.
 *
 * P2097 is a property of an OFFICE, not of a building: measured across six
 * major chambers it is empty on every legislature item and present on the
 * member's position — "United States representative" carries 2 years where the
 * House of Representatives carries nothing. So the chamber is asked first, and
 * its P527 parts second, which is where the answer actually lives.
 */
const termOf = async (entity: WikidataEntity | undefined): Promise<number | undefined> => {
  const direct = termFrom(entity)
  if (direct) return direct
  const parts = claimIds(entity, 'P527')
  if (!parts.length) return undefined
  const partEntities = await getEntities(parts, 'claims')
  for (const part of parts) {
    const term = termFrom(partEntities[part])
    if (term) return term
  }
  return undefined
}

/** A body that has been abolished is never the current legislature. */
const isDissolved = (entity: WikidataEntity | undefined): boolean =>
  (entity?.claims?.P576?.length ?? 0) > 0

/**
 * Every chamber of a country's legislature, keyed and classified.
 *
 * Returns one entry for a unicameral state and two for a bicameral one. An
 * empty result means the graph could not answer — reported, never guessed.
 */
/**
 * Legislatures the country item does not point at.
 *
 * `P194` is the link this resolver is built on and it is missing for two
 * states: the United Arab Emirates names only its Federal Supreme Council (the
 * rulers' body, not a legislature), and Afghanistan carries no P194 at all
 * since the Taliban dissolved the National Assembly in 2021.
 *
 * Both bodies exist as entities; only the edge is absent. Naming the entity is
 * a smaller and more honest intervention than inventing the composition, and
 * each row is a source gap that can be removed once Wikidata carries the link.
 */
const LEGISLATURE_OVERRIDES: Record<string, string[]> = {
  /** Federal National Council — advisory, half appointed by the emirates. */
  Q878: ['Q1479761'],
  /** National Assembly of Afghanistan — dissolved 2021, recorded as suspended. */
  Q889: ['Q2386705'],
}

export const chambersOf = async (countryQid: QID): Promise<ChamberRef[]> => {
  const country = (await getEntities([countryQid], 'claims'))[countryQid]
  const direct = [
    ...new Set([...claimIds(country, 'P194'), ...(LEGISLATURE_OVERRIDES[countryQid] ?? [])]),
  ]
  if (!direct.length) return []
  const dissolvedOnly: ChamberRef[] = []

  // Level 1: what P194 named. Level 2: the parts of anything bicameral.
  const level1 = await getEntities(direct, 'claims|labels|sitelinks')
  // Always descend into P527. Restricting the descent to `Q189445` parents lost
  // Switzerland, whose Federal Assembly is classed only `Q35749` (parliament)
  // while seating a perfectly well-typed National Council and Council of
  // States. The role filter below discards the committees and staff positions
  // that P527 also lists, so descending widely costs nothing.
  const candidates = new Set<string>(direct)
  const partIds: string[] = []
  for (const id of direct) {
    for (const part of claimIds(level1[id], 'P527')) {
      candidates.add(part)
      partIds.push(part)
    }
  }

  // A body can carry BOTH classes: Norway's Storting and Turkey's Grand
  // National Assembly are filed bicameral (as they once were) and unicameral
  // (as they now are), with their former chambers still listed under P527 and
  // marked dissolved. So "is this a container?" is answered by whether it has a
  // LIVE chamber part, not by the class — treating the class as decisive lost
  // both countries entirely.
  const parts = partIds.length ? await getEntities(partIds, 'claims') : {}
  const liveParts = new Set<string>()
  for (const id of partIds) {
    const entity = parts[id]
    if (!entity || isDissolved(entity)) continue
    // A part only makes its parent a container when the part is itself a
    // CHAMBER. Turkey lists "member of the Grand National Assembly" — a
    // position, live and permanent — under P527, and counting that as a live
    // chamber made the Assembly look bicameral and dropped the country.
    if (await roleFromClasses(claimIds(entity, 'P31'))) liveParts.add(id)
  }

  const entities = await getEntities([...candidates], 'claims|labels|sitelinks')
  const byRole = new Map<ChamberRole, ChamberRef>()

  for (const id of candidates) {
    const entity = entities[id]
    if (!entity) continue
    if (isDissolved(entity)) {
      // Keep it aside. Afghanistan, Mali, Myanmar and Niger reach here because
      // their legislatures really were dissolved — by the Taliban and by three
      // coups — and Eritrea's has never convened since 2002. Dropping the
      // country would hide that; the chamber is recorded with its seats and
      // marked `suspended` instead, which is the true and more useful answer.
      const name = labelOf(entity)
      const role = name ? ((await roleFromClasses(claimIds(entity, 'P31'))) ?? roleFromName(name)) : undefined
      if (name && role) {
        const ref: ChamberRef = { qid: id as QID, role, name, inferred: true, dissolved: true }
        const article = enwikiTitle(entity)
        if (article) ref.article = article
        const local = nativeName(entity)
        if (local && local !== name) ref.name_local = local
        const seats = seatsOf(entity)
        if (seats) ref.seats_total = seats
        dissolvedOnly.push(ref)
      }
      continue
    }
    const classes = claimIds(entity, 'P31')
    // A bicameral parent is a container — but only while it actually contains
    // live chambers (see `liveParts`).
    if (classes.includes(BICAMERAL) && claimIds(entity, 'P527').some(id => liveParts.has(id))) {
      continue
    }
    // The role IS the membership test. P527 also lists libraries, chauffeur
    // services and monarchs, and none of those reach a role — where a house
    // does, whatever else its class hierarchy says. Requiring `legislative
    // house` on top of the role lost Turkey, whose unicameral class subclasses
    // to `parliament` and never to `legislative house`.
    const name = labelOf(entity)
    if (!name) continue
    const role = (await roleFromClasses(classes)) ?? roleFromName(name)
    if (!role) continue
    const ref: ChamberRef = {
      qid: id as QID,
      role,
      name,
      inferred: !classes.some(cls => cls in ROLE_ROOTS),
    }
    const article = enwikiTitle(entity)
    if (article) ref.article = article
    const local = nativeName(entity)
    // Only when it differs — "Riigikogu" is both the English and the Estonian
    // name, and repeating it says nothing.
    if (local && local !== name) ref.name_local = local
    const seats = seatsOf(entity)
    if (seats) ref.seats_total = seats
    const term = await termOf(entity)
    if (term) ref.term_years = term

    // When two candidates claim the same role, prefer the one with an article
    // — the composition has to be read from somewhere.
    const held = byRole.get(role)
    if (!held || (!held.article && ref.article)) byRole.set(role, ref)
  }

  // A country cannot be both unicameral and bicameral. When the graph says
  // both, the two-house reading wins: a unicameral class on a parent is the
  // commoner error (Norway's Storting carries both, and seats two abolished
  // chambers under P527).
  const roles = [...byRole.keys()]
  if (roles.includes('unicameral') && (roles.includes('lower') || roles.includes('upper'))) {
    byRole.delete('unicameral')
  }

  // A country with exactly ONE house does not have a lower house — it has a
  // legislature. Denmark's Folketing carries `lower house` from the century it
  // sat opposite a Landsting, abolished in 1953. Where nothing upper survives,
  // the surviving house is the whole thing, and calling it `lower` would imply
  // a second chamber a consumer would go looking for.
  //
  // Haiti and Kazakhstan reach here honestly: Haiti's Senate is dissolved and
  // the country has had no sitting parliament since 2023, and Kazakhstan's
  // Mäjilis is marked dissolved between terms. Relabelling is right in both —
  // the missing house is recorded as an omission, not implied by a role.
  // Nothing live at all: report what the country HAD, marked dissolved.
  if (!byRole.size && dissolvedOnly.length) {
    const best = new Map<ChamberRole, ChamberRef>()
    for (const ref of dissolvedOnly) if (!best.has(ref.role)) best.set(ref.role, ref)
    return [...best.values()].sort((a, b) => a.role.localeCompare(b.role))
  }

  const survivors = [...byRole.keys()]
  if (survivors.length === 1 && survivors[0] !== 'unicameral') {
    const only = byRole.get(survivors[0]!)!
    byRole.clear()
    byRole.set('unicameral', { ...only, role: 'unicameral', inferred: true })
  }
  return [...byRole.values()].sort((a, b) => a.role.localeCompare(b.role))
}
