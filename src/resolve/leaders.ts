import type { Snak } from '../net/wiki'
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
import type { ExecutivePower, GovernmentForm } from '../types/enums'
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
/** The OFFICE of head of state / head of government, on the country item. */
const OFFICE_OF_HEAD_OF_STATE = 'P1906'
const OFFICE_OF_HEAD_OF_GOVERNMENT = 'P1313'
/** Who holds an office, on the office item. */
const OFFICEHOLDER = 'P1308'
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
  // A country that says nothing but "republic" has told us almost nothing.
  // `other` is the honest answer and keeps the office rules above in charge,
  // where guessing parliamentary made Egypt's president ceremonial.
  [/^republic$/i, 'other'],
]

export interface FormResult {
  form: GovernmentForm
  form_raw: string[]
}

/**
 * The form, read from a country article's `government_type` prose.
 *
 * Ordered most-specific first, exactly like the P122 rules and for the same
 * reason: the line usually says several things at once, and "under a military
 * junta" outranks the "presidential republic" it qualifies.
 */
const FORM_BY_PROSE: [RegExp, GovernmentForm][] = [
  [/military junta|under (a )?military|military government|junta/i, 'military_junta'],
  [/provisional|transitional|caretaker/i, 'transitional'],
  [/one[- ]party|single[- ]party/i, 'one_party_state'],
  [/dominant[- ]party/i, 'dominant_party_state'],
  // "Islamic republic" alone is NOT a theocracy — Mauritania's line reads
  // "semi-presidential Islamic republic", which describes its constitutional
  // religion, not clerical rule. Only an explicit theocracy qualifies, and
  // the machinery rules below get first refusal.
  [/theocra/i, 'theocracy'],
  [/absolute monarchy/i, 'absolute_monarchy'],
  [/(constitutional|parliamentary|federal) monarchy/i, 'constitutional_monarchy'],
  [/semi[- ]presidential/i, 'semi_presidential_republic'],
  [/parliamentary republic|parliamentary democracy|parliamentary system/i, 'parliamentary_republic'],
  [/presidential republic|presidential system/i, 'presidential_republic'],
  // Last, so it never pre-empts the machinery above.
  [/islamic republic/i, 'theocracy'],
]

/**
 * Which office runs the government.
 *
 * `form` settles most of it: a presidential republic is led by its president,
 * a parliamentary republic or constitutional monarchy by its prime minister.
 * The hard set is the 28 semi-presidential republics, where the label covers
 * both France (the president governs) and Austria (the chancellor does).
 *
 * The article's own prose separates them, and it is the same signal that fixed
 * `form` itself: Austria's reads "federal parliamentary republic", Cape
 * Verde's and Congo's "parliamentary republic", while Azerbaijan's and
 * Belarus' read "presidential system". Where the prose says nothing, the
 * president is the safer default — a semi-presidential republic whose
 * presidency is purely ceremonial is the rarer shape.
 */
/**
 * Semi-presidential republics whose article names no system, and whose premier
 * nevertheless governs. Verified individually; everything else in that set
 * takes the president.
 */
const SEMI_PRESIDENTIAL_PREMIER = new Set(['PT', 'ST'])

export const executivePowerOf = (
  form: GovernmentForm,
  prose: string[],
  hasHeadOfGovernment: boolean,
  iso = ''
): ExecutivePower => {
  const line = prose.join(' ').toLowerCase()

  // Checked BEFORE the single-officeholder shortcut: Switzerland records no
  // separate head of government because its Federal Council holds both roles
  // as a body, so exiting early would have called a seven-member collective a
  // head of state.
  if (
    /directorial system|federal council|collective (?:leadership|presidency)|ruling council/.test(
      line
    )
  ) {
    return 'collective'
  }

  // No separate head of government means one person holds both offices.
  if (!hasHeadOfGovernment) return 'head_of_state'

  // A semi-presidential autocracy is president-led, whatever else the labels
  // say.
  //
  // Checked before the parliamentary override because the stale label was
  // beating it: Congo-Brazzaville's summary reads "Unitary semi-presidential
  // republic under an authoritarian dictatorship" beside a leftover
  // "parliamentary republic", and Denis Sassou Nguesso has ruled since 1997,
  // appoints the prime minister, and reappointed him days after a pro-forma
  // resignation. Where a semi-presidential source says the state is a
  // dictatorship, the presidency is where the power sits.
  //
  // The form guard is the whole rule. "Dictatorship" says WHO rules, not WHICH
  // OFFICE they rule from, and in a structurally premier-led state the answer
  // is the premiership: Cambodia's summary says "parliamentary constitutional
  // elective monarchy under a hereditary dictatorship" and Togo's "parliamentary
  // republic under an authoritarian dictatorship", but Hun Manet and Faure
  // Gnassingbé ARE the heads of government. Without the guard this rule handed
  // both countries to a ceremonial king and a figurehead president.
  if (
    form === 'semi_presidential_republic' &&
    /dictatorship|autocra|personalist/.test(line)
  ) {
    return 'head_of_state'
  }

  // The prose outranks `form` where it names a parliamentary system outright.
  // Pakistan is the case: its article says "Federal parliamentary Islamic
  // republic" and Shehbaz Sharif governs, but `form` keyword-matches
  // "Islamic" to `theocracy` (a known misclassification) and would hand the
  // country to President Zardari.
  // `parliamentary` and its noun are not always adjacent — Pakistan's article
  // says "Federal parliamentary Islamic republic" — so the words between them
  // are allowed for.
  //
  // It may only RESCUE a misclassified form, never overrule one that already
  // resolved to a president-led type. `line` is P122's raw labels joined with
  // the article's summary, and P122 returns unranked multi-values mixing the
  // current with the historical — the same defect FORM_BY_QID exists to
  // absorb. Tunisia carries a stale "parliamentary republic" beside "Unitary
  // presidential republic", Kyrgyzstan the same; both handed the country to a
  // premier who does not govern. Tunisia's 2022 constitution gives the
  // president sole control of the executive, and Kyrgyzstan's 2021 referendum
  // reinstated the presidency as chief executive with the premier demoted to
  // senior adviser.
  //
  // `presidential_republic` is the only form excluded, because it is the only
  // one whose definition CONTRADICTS a premier-led reading. Semi-presidential
  // republics genuinely split (Austria and Cape Verde are premier-led, Egypt
  // and the DRC are not) and keep the override, which is right for them.
  if (
    form !== 'presidential_republic' &&
    /parliamentary(?:\s+\w+)?\s+(?:republic|system|democracy|monarchy)/.test(line)
  ) {
    return 'head_of_government'
  }

  switch (form) {
    case 'presidential_republic':
    case 'one_party_state':
    case 'dominant_party_state':
    case 'theocracy':
    case 'military_junta':
      return 'head_of_state'
    // A monarch who appoints their own prime minister governs through them.
    // The UAE is the case that matters: the president (ruler of Abu Dhabi)
    // appoints the prime minister (ruler of Dubai), so the premiership is a
    // division of authority between emirates rather than a transfer of it.
    case 'absolute_monarchy':
      return 'head_of_state'
    case 'parliamentary_republic':
      return 'head_of_government'
    case 'constitutional_monarchy':
      // Nearly all are premier-led — Britain, Sweden, Japan, Spain. The UAE is
      // not: its own article calls it an "absolute monarchy" and a "federal
      // semi-presidential elective semi-constitutional monarchy" in the same
      // breath, and the president (ruler of Abu Dhabi) appoints the prime
      // minister (ruler of Dubai). Where the prose still says absolute, the
      // crown governs.
      return /absolute monarchy/.test(line) ? 'head_of_state' : 'head_of_government'
    case 'semi_presidential_republic':
      // The prose is the tiebreak, and "parliamentary" in it is decisive:
      // Austria and Cape Verde both carry it and are premier-led. (Congo used
      // to be listed here too, and is not — see the autocracy rule above.)
      if (/parliamentary/.test(line)) return 'head_of_government'
      if (/presidential system|executive presiden/.test(line)) return 'head_of_state'
      // Eight say neither, and they genuinely split — Portugal's premier is
      // the chief executive while Egypt's and the DRC's presidents govern. The
      // president is the default because it is right for six of the eight; the
      // two that are not are named in SEMI_PRESIDENTIAL_PREMIER below.
      return SEMI_PRESIDENTIAL_PREMIER.has(iso) ? 'head_of_government' : 'head_of_state'
    default:
      // `other` and `transitional`. Cuba lands here and its president governs
      // — the 2019 constitution restored a premiership to run the Council of
      // Ministers day to day, not to lead. So this follows the same default as
      // everything unclassified: the head of state, unless the prose above
      // already said parliamentary.
      return 'head_of_state'
  }
}

export const formFromProse = (line: string | undefined): GovernmentForm | undefined => {
  if (!line) return undefined
  for (const [pattern, form] of FORM_BY_PROSE) if (pattern.test(line)) return form
  return undefined
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

/**
 * The office a leader holds, and its name in its own language.
 *
 * Read from the OFFICE ITEM the country points at (P1906 / P1313) rather than
 * from a qualifier on the leadership statement. The qualifier is present for 22
 * of 193 heads of state and for none of the heads of government, where the
 * office item exists almost everywhere and carries the native label besides —
 * "Bundeskanzler", "Statsminister", "Taoiseach". The last of those is the case
 * that makes it worth having: nobody in Ireland says prime minister.
 */
const officeDetail = async (
  officeQid: string | undefined,
  fallback: ReturnType<typeof currentStatement>
): Promise<{ office?: Entity; office_local?: string }> => {
  const qualified = fallback?.qualifiers?.[POSITION_HELD]?.[0]
    ? claimId({ mainsnak: fallback.qualifiers[POSITION_HELD][0] })
    : undefined
  const id = officeQid ?? qualified
  if (!id) return {}
  const entity = (await getEntities([id], 'labels|claims'))[id]
  const label = labelOf(entity)
  const native = ['P1705', 'P1448'].reduce<string | undefined>((found, property) => {
    if (found) return found
    const statement = currentStatement(entity?.claims?.[property])
    const raw = statement?.mainsnak?.datavalue?.value as { text?: string } | undefined
    return raw?.text?.trim() || undefined
  }, undefined)
  return {
    office: { qid: id as QID, ...(label ? { label } : {}) },
    ...(native && native !== label ? { office_local: native } : {}),
  }
}

export interface Leaders {
  head_of_state: OfficeHolder | null
  head_of_government: OfficeHolder | null
  /** True when one person holds both offices — the reason HoG may be null. */
  same_person: boolean
  /** The form, possibly corrected by what the offices turned out to be. */
  form: GovernmentForm
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
/**
 * Who holds an office, asked of the OFFICE rather than the country.
 *
 * The country's P35/P6 is written when a leader arrives and frequently never
 * closed when they leave: Somalia still names a prime minister who left in
 * 2022, Sudan one who resigned the same year, Chad one who DIED in 2021.
 *
 * The office item is a different page with different editors, and it is
 * maintained where the country's statement is not. Asked directly, it returns
 * Somalia's Hamza Abdi Barre, the DRC's Judith Suminwa, Kazakhstan's Olzhas
 * Bektenov and Chad's Allamaye Halina — every one of them the answer the
 * country item was three to five years behind on.
 *
 * So the office is tried FIRST and the country's own statement is the fallback.
 * Neither is authoritative on its own; the disagreement between them is what
 * `superseded` reports.
 */
/**
 * The holder an office item can be trusted to name, if any.
 *
 * An office that says its own past holders were WRONG is not maintained.
 * Deprecated rank means "this statement is false" — not "this term ended",
 * which is what an end date is for. A real predecessor is closed, never
 * deprecated, so an office carrying deprecated holders has been edited by
 * someone who misread the rank, and whatever they left open is not evidence.
 *
 * Nepal is the case: all three genuine presidents sit deprecated AND closed,
 * leaving the VICE president as the only open holder, and we published him as
 * head of state with his vice-presidential portrait attached. The country item
 * had Ram Chandra Poudel right all along.
 *
 * Measured against every country where the two sources disagree, this separates
 * cleanly: all seventeen legitimate office-wins carry ZERO deprecated holders;
 * Nepal's presidency carries three of four. Preferring the country item on rank
 * instead — the other obvious fix — would have broken all seventeen.
 */
export const trustedHolder = (holders: Snak[]): Snak | undefined => {
  if (holders.some(held => held.rank === 'deprecated')) return undefined
  const { statement, stale } = resolveStatement(holders)
  // An office whose every holder statement is closed is a vacancy, not an
  // answer — Chad's premiership reads that way and must fall through.
  return stale ? undefined : statement
}

const holderOfOffice = async (
  country: WikidataEntity | undefined,
  officeProperty: string
): Promise<{ id: string; statement: Snak } | undefined> => {
  const offices = claimIds(country, officeProperty)
  if (!offices.length) return undefined
  const entities = await getEntities(offices, 'claims')
  for (const office of offices) {
    const statement = trustedHolder(entities[office]?.claims?.[OFFICEHOLDER] ?? [])
    if (!statement) continue
    const id = claimId(statement)
    if (id) return { id, statement }
  }
  return undefined
}

export const leadersOf = async (
  countryQid: QID,
  form: GovernmentForm,
  retrievedAt: string,
  /** The source stated this form outright rather than it being inferred. */
  explicit = false
): Promise<Leaders> => {
  const country = (await getEntities([countryQid], 'claims'))[countryQid]

  const build = async (
    property: string,
    represents: OfficeHolder['represents']
  ): Promise<OfficeHolder | null> => {
    // TWO independent sources, and neither is trustworthy on its own.
    //
    // The office item is right where the country is years behind (Somalia,
    // Kazakhstan, the DRC's premiership) and wrong where nobody has touched it
    // (the DRC's presidency still names Joseph Kabila, who left in 2019, on a
    // single statement with no start date at all).
    //
    // So they are compared on EVIDENCE rather than ranked by source: the claim
    // that carries a start date wins, and the later start wins between two that
    // do. A statement nobody dated is a statement nobody has revisited.
    const officeProperty =
      property === HEAD_OF_STATE ? OFFICE_OF_HEAD_OF_STATE : OFFICE_OF_HEAD_OF_GOVERNMENT
    const fromOffice = await holderOfOffice(country, officeProperty)
    const fallback = resolveStatement(country?.claims?.[property])

    const officeStart = fromOffice ? startedOn(fromOffice.statement) : undefined
    const countryStart = startedOn(fallback.statement)
    const preferOffice =
      !!fromOffice &&
      (!fallback.statement ||
        fallback.stale ||
        (!!officeStart && (!countryStart || officeStart > countryStart)))

    const statement = preferOffice ? fromOffice!.statement : (fallback.statement ?? fromOffice?.statement)
    const stale = preferOffice ? false : fallback.stale
    const id = preferOffice ? fromOffice!.id : (statement ? claimId(statement) : undefined)
    if (!id) return null
    const person = (await getEntities([id], 'labels|claims'))[id]
    const name = labelOf(person)
    // Wikidata itself sometimes carries a placeholder where a person belongs —
    // Burundi's head of state resolved to a label reading "<UNKNOWN>". A leader
    // we cannot name is not a leader we should publish.
    if (!name || /^[<(\[]|unknown|vacant|n\/a$/i.test(name.trim())) return null

    // CROSS-CHECK the country's claim against the person's own record.
    //
    // A country's P35/P6 statement is written when a leader arrives and often
    // never closed when they leave, so "open" is not the same as "current".
    // Somalia still names a prime minister who left in 2022, Sudan one who
    // resigned the same year, Chad one who DIED in 2021 — every one of them an
    // open statement on the country item.
    //
    // The person's own P39 (position held) is maintained where the country's is
    // not: an ex-leader's positions are all closed, and a death date is
    // decisive. Measured across five stale records and three current ones, the
    // separation was exact — every stale leader had zero open positions, every
    // current one had some.
    //
    // This is a REPORTING rule, not a correction: we cannot know who replaced
    // them, so the best available name is kept and marked, which is what
    // `confidence` and `derivation` exist to carry. A country dropped for a
    // stale statement would be a worse answer than a country flagged.
    const deceased = (person?.claims?.P570?.length ?? 0) > 0
    const positions = person?.claims?.P39 ?? []
    const openPositions = positions.filter(
      held => held.rank !== 'deprecated' && !held.qualifiers?.P582?.length
    ).length
    const departed = deceased || (positions.length > 0 && openPositions === 0)
    const since = startedOn(statement)
    const { office, office_local } = await officeDetail(
      claimIds(country, officeProperty)[0],
      statement
    )
    const portrait = await portraitOf(person)
    return {
      person: { qid: id as QID, label: name },
      name,
      ...(office ? { office } : {}),
      ...(office_local ? { office_local } : {}),
      party: await partyOf(person),
      ...(since ? { since } : {}),
      ...(portrait ? { portrait } : {}),
      represents,
      ...(departed || stale ? { superseded: true } : {}),
      provenance: {
        kind: 'wikidata',
        derivation: departed || stale ? 'derived' : 'structured',
        qid: countryQid,
        retrieved_at: retrievedAt,
      },
    }
  }

  // The form is the first guess: in a parliamentary republic or a
  // constitutional monarchy the head of state is ceremonial.
  //
  // It is only a guess, because P122 is frequently too coarse to settle it.
  // Egypt is filed a bare "republic" and folds to parliamentary, which made
  // el-Sisi — the dominant executive of a presidential system — ceremonial.
  // India folds to presidential on "constitutional republic", which made
  // President Murmu political when the office is the ceremonial one.
  //
  // The OFFICE decides where the form cannot. A head of state who is called a
  // president and who also appoints the government is political; a monarch is
  // ceremonial wherever a prime minister exists.
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

  // A crowned head of state is ceremonial whenever a prime minister exists,
  // whatever the form folded to — and a president in a system Wikidata could
  // not classify is political, since a purely ceremonial presidency is the
  // exception that a parliamentary form would have named.
  //
  // EXCEPT under an absolute monarchy, where the crown IS the executive and
  // the prime minister serves at its pleasure. Reading the title alone made
  // Brunei's Sultan, Oman's Sultan and Saudi Arabia's King ceremonial — the
  // exact inverse of their power — because each appoints a premier beneath
  // them. `form` is what separates them from Britain and Sweden, and it is
  // stated outright on all three rather than inferred.
  if (head_of_state && head_of_government) {
    const office = `${head_of_state.office?.label ?? ''} ${head_of_state.name}`
    if (form === 'absolute_monarchy') {
      head_of_state.represents = 'political'
    } else if (/\b(king|queen|emir|sultan|emperor|grand duke|prince)\b/i.test(office)) {
      head_of_state.represents = 'ceremonial'
    } else if (form === 'other' || form === 'dominant_party_state' || form === 'one_party_state') {
      head_of_state.represents = 'political'
    }
  }

  // A form of `presidential_republic` alongside a SEPARATE head of government
  // is a contradiction: a presidential system's whole definition is that the
  // president IS the head of government. India reaches it on "constitutional
  // republic" — its P122 says nothing but four flavours of "republic" — and the
  // result made President Murmu political and Prime Minister Modi's office
  // secondary, which is exactly backwards.
  //
  // Where the structure and the label disagree, the STRUCTURE wins: two
  // separate offices means a parliamentary arrangement.
  //
  // It applies only where the form was INFERRED from a vague label. Where a
  // source states the system outright, it is describing a real arrangement we
  // have no business overruling: a presidential republic may perfectly well
  // appoint a prime minister to run the cabinet, and most of West and Central
  // Africa does exactly that. Overruling them turned Cameroon, Chad, Djibouti,
  // Gabon, Guinea and the CAR into parliamentary republics they have never been.
  const corrected: GovernmentForm =
    form === 'presidential_republic' && head_of_state && head_of_government && !same && !explicit
      ? 'parliamentary_republic'
      : form
  if (corrected !== form && head_of_state) head_of_state.represents = 'ceremonial'

  return {
    head_of_state,
    head_of_government: same ? null : head_of_government,
    same_person: same,
    form: corrected,
  }
}

export const partyIdsOf = (person: WikidataEntity | undefined): string[] =>
  claimIds(person, MEMBER_OF_PARTY)
