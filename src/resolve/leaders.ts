import {
  claimId,
  claimIds,
  claimStrings,
  currentStatement,
  fileLicence,
  resolveStatement,
  filePathUrl,
  getEntities,
  labelOf,
  startedOn,
  type WikidataEntity,
} from '../net/wiki'
import type { GovernmentForm } from '../types/enums'
import type { Entity, ImageRef, OfficeHolder, QID } from '../types/polity'

/**
 * Who holds office, and what kind of state they hold it in.
 *
 * Every value here is read at PREFERRED RANK with open statements only. That
 * rule is the whole file: measured on the United States' P6, there are 46
 * statements and exactly one preferred with no end date. A naive "no end date"
 * filter returns two current prime ministers for Estonia, whose predecessor's
 * statement was never closed.
 */

const HEAD_OF_STATE = 'P35'
const HEAD_OF_GOVERNMENT = 'P6'
const BASIC_FORM = 'P122'
const POSITION_HELD = 'P39'
const MEMBER_OF_PARTY = 'P102'
const IMAGE = 'P18'

/**
 * Wikidata's forms folded onto the dataset's closed set.
 *
 * P122 is unusable raw: it returns unranked multi-values mixing the current
 * with the historical and the pejorative — South Africa lists `apartheid`,
 * Estonia `authoritarianism`, the United States five forms at once. So it is
 * read at preferred rank and mapped here, with every raw label kept beside it.
 */
const FORM_BY_QID: Record<string, GovernmentForm> = {
  // Deliberately SPARSE. Every id here was read off a live country item and
  // checked by label — an earlier version guessed `Q1520223` was constitutional
  // monarchy when it is "constitutional republic", which made the United States
  // a monarchy. Where an id is not listed the label rules below decide, and
  // where neither answers the form is `other` rather than a guess.
  Q41614: 'constitutional_monarchy',
  Q7270: 'parliamentary_republic',
  Q1631218: 'parliamentary_republic',
  Q5455415: 'presidential_republic',
  Q49892: 'presidential_republic',
  Q19913: 'semi_presidential_republic',
  Q7269: 'absolute_monarchy',
  Q184558: 'absolute_monarchy',
  Q1140229: 'theocracy',
  Q432758: 'theocracy',
  Q1394991: 'one_party_state',
  Q222102: 'one_party_state',
  Q2557638: 'military_junta',
  Q1128324: 'military_junta',
  Q6229: 'transitional',
  /** "people's republic" — China, Laos, Vietnam. A ruling party that permits
   *  no rival, whatever the constitution says. */
  Q465613: 'dominant_party_state',
  /** "socialist state". */
  Q217680: 'dominant_party_state',
}

/**
 * Matched against the raw labels when no Q-id in the table applies.
 *
 * ORDER IS THE RULE. P122 returns several labels at once and they are not
 * equally informative: North Korea lists "one-party state", "family
 * dictatorship", "socialist state" AND "republic", and whichever pattern fires
 * first decides the answer. So the list runs most-specific first — a country
 * that says "one-party state" has told you more than one that says "republic",
 * and reading the vaguer label first made North Korea and Vietnam
 * parliamentary republics.
 */
const FORM_BY_LABEL: [RegExp, GovernmentForm][] = [
  // Regimes first: these describe who may hold power, which outranks the
  // machinery of how it is exercised.
  [/junta|military (rule|government|dictatorship)/i, 'military_junta'],
  [/one[- ]party|single[- ]party/i, 'one_party_state'],
  [/dominant[- ]party|people'?s republic|socialist state|communist/i, 'dominant_party_state'],
  [/(provisional|transitional|caretaker) government/i, 'transitional'],
  // Monarchies before theocracy: Saudi Arabia is both, and which family holds
  // the throne is the structural fact where "islamic theocracy" describes the
  // law it rules by. Iran is the other way round — a theocracy with no
  // monarch — and reaches the theocracy rule because no monarchy pattern fires.
  // Absolute before constitutional, since the former contains "monarchy".
  [/absolute monarchy/i, 'absolute_monarchy'],
  [/(constitutional|parliamentary|hereditary) monarchy/i, 'constitutional_monarchy'],
  [/theocra|islamic (republic|state)/i, 'theocracy'],
  // Republics, most specific first. "Semi-presidential" contains
  // "presidential", and "constitutional republic" must not reach a monarchy.
  [/semi[- ]presidential/i, 'semi_presidential_republic'],
  [/parliamentary (republic|democracy|system)/i, 'parliamentary_republic'],
  [/presidential (system|republic)/i, 'presidential_republic'],
  // Last resort: a bare "republic" says only that nobody inherits the job.
  // Presidential is the commoner shape and the one the United States means by
  // "constitutional republic", but this is a fallback and reads as one.
  [/constitutional republic|federal republic|democratic republic/i, 'presidential_republic'],
]

export interface FormResult {
  form: GovernmentForm
  form_raw: string[]
}

export const governmentForm = async (
  country: WikidataEntity | undefined
): Promise<FormResult> => {
  const statements = country?.claims?.[BASIC_FORM] ?? []
  const open = statements.filter(
    statement => statement.rank !== 'deprecated' && !statement.qualifiers?.P582?.length
  )
  const preferred = open.filter(statement => statement.rank === 'preferred')
  const pool = preferred.length ? preferred : open
  const ids = pool.map(claimId).filter((id): id is string => !!id)
  if (!ids.length) return { form: 'other', form_raw: [] }

  const entities = await getEntities(ids, 'labels')
  const labels = ids.map(id => labelOf(entities[id])).filter((label): label is string => !!label)

  // Labels FIRST, because they are ordered by specificity and the id table is
  // not. North Korea lists seven forms at once — "one-party state" alongside a
  // bare "republic" — and any unordered lookup answers with whichever it
  // happens to see, which made it a parliamentary republic.
  for (const [pattern, form] of FORM_BY_LABEL) {
    if (labels.some(label => pattern.test(label))) return { form, form_raw: labels }
  }
  for (const id of ids) {
    const mapped = FORM_BY_QID[id]
    if (mapped) return { form: mapped, form_raw: labels }
  }
  return { form: 'other', form_raw: labels }
}

const portraitOf = async (person: WikidataEntity | undefined): Promise<ImageRef | undefined> => {
  const file = claimStrings(person, IMAGE)[0]
  if (!file) return undefined
  const licence = await fileLicence(file)
  if (!licence) return undefined
  return {
    file,
    url: filePathUrl(file, licence.host),
    host: licence.host,
    ...(licence.license ? { license: licence.license } : {}),
    non_free: licence.non_free,
    ...(licence.restrictions ? { restrictions: licence.restrictions } : {}),
    ...(licence.credit ? { credit: licence.credit } : {}),
  }
}

/**
 * The party a person currently belongs to.
 *
 * Leaders keep historical memberships whose statements were never closed, so
 * "the first live statement" reaches a defunct party — Putin and Lukashenko
 * both surface the Communist Party of the Soviet Union that way. Preferred rank
 * and the latest start date is what avoids it.
 */
const partyOf = async (person: WikidataEntity | undefined): Promise<Entity | null> => {
  const statement = currentStatement(person?.claims?.[MEMBER_OF_PARTY])
  const id = statement ? claimId(statement) : undefined
  if (!id) return null
  const entity = (await getEntities([id], 'labels|claims'))[id]
  // A dissolved party is worse than no party: it invites the reader to believe
  // an organisation exists that does not.
  if ((entity?.claims?.P576?.length ?? 0) > 0) return null
  const label = labelOf(entity)
  return { qid: id as QID, ...(label ? { label } : {}) }
}

const officeOf = async (statement: ReturnType<typeof currentStatement>): Promise<Entity | undefined> => {
  const id = statement?.qualifiers?.[POSITION_HELD]?.[0]
    ? claimId({ mainsnak: statement.qualifiers[POSITION_HELD][0] })
    : undefined
  if (!id) return undefined
  const entity = (await getEntities([id], 'labels'))[id]
  const label = labelOf(entity)
  return { qid: id as QID, ...(label ? { label } : {}) }
}

export interface Leaders {
  head_of_state: OfficeHolder | null
  head_of_government: OfficeHolder | null
  /** True when one person holds both offices — the reason HoG may be null. */
  same_person: boolean
}

/**
 * A country's two leadership roles.
 *
 * `head_of_government` is deliberately null when the SAME PERSON holds both, so
 * "one person does both jobs" is distinguishable from "we only found one".
 * `represents` records which office speaks politically and which ceremonially:
 * Germany's Chancellor is at the G7 while the President signs treaties, and
 * Britain's King is at the banquet while the Prime Minister negotiates.
 */
export const leadersOf = async (
  countryQid: QID,
  form: GovernmentForm,
  retrievedAt: string
): Promise<Leaders> => {
  const country = (await getEntities([countryQid], 'claims'))[countryQid]

  const build = async (
    property: string,
    represents: OfficeHolder['represents']
  ): Promise<OfficeHolder | null> => {
    const { statement, stale } = resolveStatement(country?.claims?.[property])
    const id = statement ? claimId(statement) : undefined
    if (!id) return null
    const person = (await getEntities([id], 'labels|claims'))[id]
    const name = labelOf(person)
    if (!name) return null
    const since = startedOn(statement)
    const office = await officeOf(statement)
    const portrait = await portraitOf(person)
    return {
      person: { qid: id as QID, label: name },
      name,
      ...(office ? { office } : {}),
      party: await partyOf(person),
      ...(since ? { since } : {}),
      ...(portrait ? { portrait } : {}),
      represents,
      provenance: {
        kind: 'wikidata',
        derivation: stale ? 'derived' : 'structured',
        qid: countryQid,
        retrieved_at: retrievedAt,
      },
    }
  }

  // The form is the first guess: in a parliamentary republic or a
  // constitutional monarchy the head of state is ceremonial.
  const ceremonialByForm =
    form === 'parliamentary_republic' || form === 'constitutional_monarchy'
  const head_of_state = await build(HEAD_OF_STATE, ceremonialByForm ? 'ceremonial' : 'political')
  const head_of_government = await build(HEAD_OF_GOVERNMENT, 'political')

  const same =
    !!head_of_state && !!head_of_government &&
    head_of_state.person.qid === head_of_government.person.qid

  // …but the OFFICE overrules the form. Where one person holds both jobs, the
  // head of state is by definition the political leader — South Africa and El
  // Salvador are parliamentary and presidential republics respectively whose
  // president is both, and calling either ceremonial would be plainly wrong.
  if (head_of_state && (same || !head_of_government)) head_of_state.represents = 'political'

  return {
    head_of_state,
    head_of_government: same ? null : head_of_government,
    same_person: same,
  }
}

export const partyIdsOf = (person: WikidataEntity | undefined): string[] =>
  claimIds(person, MEMBER_OF_PARTY)
