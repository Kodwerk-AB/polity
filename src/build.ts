import {
  claimStrings,
  currentStatement,
  fileLicence,
  filePathUrl,
  getEntities,
  labelOf,
  openClaimIds,
} from './net/wiki'
import { unMemberStates } from './resolve/countries'
import { chambersOf, type ChamberRef } from './resolve/chambers'
import { formFromProse, governmentForm, leadersOf } from './resolve/leaders'
import { electionSince } from './extract/elections'
import { chamberSource } from './extract/source'
import { governmentTypeLine, leaderLines } from './extract/leaders'
import { extractComposition, extractLeaders, type ExtractedBloc } from './extract/model'
import { hashOf } from './net/cache'
import type { BlocKind, Confidence, Contestation, SpectrumBand } from './types/enums'
import type {
  Chamber,
  Entity,
  OfficeHolder,
  Government,
  ImageRef,
  Party,
  Polity,
  PolityDataset,
  QID,
  Seating,
} from './types/polity'

/**
 * The pipeline: resolve, extract, validate, emit.
 *
 * Each stage is deterministic except one — the composition extraction — and
 * that one is gated on a hash and checked by arithmetic afterwards. The whole
 * point of the arrangement is that a model's mistake shows up as a failed sum
 * rather than as a plausible wrong number in a published file.
 */

const today = () => new Date().toISOString().slice(0, 10)

/**
 * A date the model read, normalised or dropped.
 *
 * A bare year becomes mid-year rather than January: "2024" for an election
 * means somewhere in 2024, and anchoring it to the 1st would systematically
 * overstate how long ago it was by up to a year.
 */
/**
 * A date the model read, kept at the precision it was written.
 *
 * A bare year stays a bare year. Padding "2029" to "2029-07-01" invented four
 * months of precision nobody recorded, and the invented day was then compared
 * against the calendar: Sweden's September 2026 election was stored as 1 July
 * and read as already past on 14 August, flagging a perfectly current
 * parliament as overdue.
 */
const normaliseDate = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const text = value.trim()
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (full) {
    const year = Number(full[1])
    return year >= 1900 && year <= 2100 ? text : undefined
  }
  const bare = /^(\d{4})$/.exec(text)
  if (bare) {
    const year = Number(bare[1])
    return year >= 1900 && year <= 2100 ? bare[1] : undefined
  }
  return undefined
}

/** A date at whatever precision, as a Date. A bare year becomes its END, so a
 *  year-precision election is only "past" once the year is over. */
const asDate = (value: string | undefined, endOfYear = false): Date | undefined => {
  if (!value) return undefined
  if (/^\d{4}$/.test(value)) return new Date(`${value}-${endOfYear ? '12-31' : '01-01'}`)
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

// ---------------------------------------------------------------------------
// Contestation
// ---------------------------------------------------------------------------

/**
 * How real the contest for a chamber's seats is.
 *
 * Derived, not extracted: a model asked to judge whether an election was free
 * would be doing politics, where these signals are structural and checkable.
 * A chamber where one bloc holds nearly every seat in a one-party state is
 * uncontested by arithmetic, not by opinion.
 */
/**
 * Where a chamber stands in its electoral cycle.
 *
 * The whole point is early warning: composition drifts the moment an election
 * happens, and the dataset cannot watch 193 countries continuously — but it CAN
 * say which are near the end of a term, so a consumer re-checks the handful
 * that matter. An ABSOLUTE date, never a countdown: a "days remaining" field
 * would be wrong the morning after a weekly rebuild wrote it.
 */
const mandateOf = (
  lastElection: string | undefined,
  nextElection: string | undefined,
  termYears: number | undefined,
  asOf: Date
): Polity['chambers'][number]['mandate'] => {
  const year = 365.25 * 86_400_000
  let expected: Date | undefined
  let inferred = false
  if (nextElection) {
    // End of year for a year-only date: a 2026 election is not overdue in
    // August 2026.
    expected = asDate(nextElection, true)
  } else {
    const from = asDate(lastElection)
    if (from) {
      expected = new Date(from.getTime() + (termYears ?? 5) * year)
      inferred = true
    }
  }
  if (!expected || Number.isNaN(expected.getTime())) {
    return lastElection || nextElection ? { inferred: false, state: 'unknown' } : undefined
  }
  const remaining = expected.getTime() - asOf.getTime()
  const state = remaining < 0 ? 'overdue' : remaining <= year ? 'due_soon' : 'current'
  return { expected_end: expected.toISOString().slice(0, 10), inferred, state }
}

const contestationOf = (
  form: Polity['form'],
  chamber: ChamberRef,
  blocs: ExtractedBloc[]
): Contestation => {
  if (chamber.dissolved) return 'suspended'

  const total = blocs.reduce((sum, bloc) => sum + bloc.seats, 0)
  const largest = blocs.reduce((most, bloc) => Math.max(most, bloc.seats), 0)
  const dominance = total > 0 ? largest / total : 0
  // Rows that are somebody's party, as opposed to vacancies and independents.
  const partyRows = blocs.filter(bloc => !isResidual(bloc)).length

  // 1. The form, where it is decisive. A state that permits no rival is not
  //    holding a contest whatever its turnout says.
  if (form === 'one_party_state') return 'uncontested'
  if (form === 'military_junta' || form === 'transitional') return 'suspended'
  if (form === 'dominant_party_state') return dominance >= 0.85 ? 'uncontested' : 'restricted'
  // An absolute monarchy's assembly is appointed by the monarch — that is what
  // makes it an absolute monarchy. Saudi Arabia's Shura has never held an
  // election and all 150 members are chosen by the king, so `restricted`
  // overstated it: there is no contest to restrict.
  if (form === 'absolute_monarchy') return 'appointed'
  if (form === 'theocracy') return 'restricted'

  // 2. A house with no PARTIES in it at all.
  //
  //    Two very different things look like this. An upper chamber of delegates
  //    — Britain's Lords, Germany's Bundesrat, Canada's Senate — is appointed
  //    or indirectly chosen, and always has been. But so is a chamber where
  //    parties are BANNED: the UAE's Federal National Council seats 40 members
  //    filed as one "Independent" row, half of them appointed outright by the
  //    emirate rulers and half chosen by an electoral college the rulers pick.
  //
  //    Treating "no parties" as a data gap and falling through to the default
  //    called that competitive — a 100%-dominated appointed advisory council
  //    read as a free election. A chamber with members and no parties is not
  //    holding a party contest, whichever kind it is.
  //    A chamber with NO composition at all is a data gap, not a fact — but an
  //    upper house is appointed by default, which is what it almost always is.
  if (partyRows === 0) return chamber.role === 'upper' || total > 0 ? 'appointed' : 'competitive'

  // 3. THE ARITHMETIC, which is the part `form` cannot supply.
  //
  //    `form` is unusable for a third of the world: Wikidata's P122 returns
  //    NOTHING for 39 countries and a bare "republic" for 21 more, so a rule
  //    that only consults the label defaults them all to `competitive`. That
  //    put Cuba, Belarus, Cambodia, Equatorial Guinea and Turkmenistan in the
  //    same bucket as Denmark — 233 of 273 chambers — which would let any
  //    downstream freedom metric read the world's autocracies as democracies.
  //
  //    Seat concentration is evidence the label is not. A chamber where one
  //    bloc holds nearly everything, or where nobody stands against the
  //    government at all, is not a competitive chamber however it is described.
  //    This is a claim about the SEATS, which is all the dataset can honestly
  //    assert — a country may be listed `restricted` for a genuine landslide,
  //    which is why the field is named for the contest and not for freedom.
  // Concentration FIRST, because it is the strongest evidence and does not
  // depend on the source having split the chamber into sides at all. Cuba at
  // 94% is uncontested however its rows are labelled; checking the weaker
  // opposition-share rule first called it merely restricted.
  if (total > 0 && partyRows > 0) {
    // A single party holding the entire chamber.
    if (partyRows === 1 && dominance >= 0.99) return 'uncontested'
    // Effectively no opposition: one bloc past 90%.
    if (dominance >= 0.9) return 'uncontested'
    // A supermajority no ordinary election produces.
    if (dominance >= 0.75) return 'restricted'
  }

  // A chamber the source never split into sides tells us nothing about who
  // opposes whom. Switzerland is the case — every party filed `non_attached`,
  // because its executive is elected by the assembly rather than formed from a
  // majority — and judging it on opposition share called one of the world's
  // most competitive parliaments restricted. Where no row is marked government
  // OR opposition, only concentration can speak.
  const unaligned =
    blocs.every(bloc => bloc.standing !== 'government' && bloc.standing !== 'opposition')

  if (total > 0 && partyRows > 0 && !unaligned) {
    // NOBODY IN OPPOSITION. The sharpest signal there is, and the one
    // dominance misses entirely: Belarus seats five parties and 40
    // "independents" with not one opposition member, and Turkmenistan four
    // blocs the same way. Each looked competitive on concentration alone —
    // 46% and 52% — because the ruling bloc is deliberately split.
    //
    // A real chamber has somebody voting against the government. One that does
    // not, and that seats enough members for it to be meaningful, is not
    // holding a contest.
    const opposition = blocs
      .filter(bloc => bloc.standing === 'opposition')
      .reduce((sum, bloc) => sum + bloc.seats, 0)
    const governing = blocs
      .filter(bloc => bloc.standing === 'government' || bloc.standing === 'backing')
      .reduce((sum, bloc) => sum + bloc.seats, 0)
    // The signal is "everyone is with the government", not "nobody is marked
    // opposition". Switzerland is the difference: its executive is not drawn
    // from a parliamentary majority, so the source files every party as
    // unaligned and no row says `government` either. That is a consensus
    // system, not a captured one, and it is among the most competitive
    // chambers in the world.
    if (opposition === 0 && governing >= total * 0.9 && partyRows >= 2 && total >= 20) {
      return 'uncontested'
    }

    // An opposition that exists but holds almost nothing.
    if (opposition / total <= 0.05) return 'restricted'
  }

  return 'competitive'
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

const HEX = /^[0-9A-Fa-f]{6}$/

/**
 * The party's own name for itself — Fidesz's "Magyar Polgári Szövetség",
 * Morena's "Movimiento Regeneración Nacional".
 *
 * From P1705 (native label), the same property the chambers use. Worth carrying
 * for the same reason: the endonym is frequently the name a reader actually
 * recognises, and an English translation ("Ecologist Green Party of Mexico")
 * is often nobody's idea of what the party is called.
 *
 * Only kept when it differs from the English label, since repeating it says
 * nothing.
 */
const endonymOf = (entity: Parameters<typeof labelOf>[0], english: string): string | undefined => {
  for (const property of ['P1705', 'P1448', 'P1549']) {
    // Through the SAME incumbency rule as every other statement. Taking [0]
    // read Sweden's Centre Party as "Bondeförbundet" — the farmers' league it
    // stopped being in 1957, sitting in the data with an explicit end date
    // beside the live "Centerpartiet".
    const statement = currentStatement(entity?.claims?.[property])
    const raw = statement?.mainsnak?.datavalue?.value
    const text = (raw as { text?: string } | undefined)?.text
    if (text && text.trim() && text.trim() !== english) return text.trim()
  }
  return undefined
}

/** The party's short form — "AfD", "CDU" — from P1813 (short name). */
const abbreviationOf = (entity: Parameters<typeof labelOf>[0]): string | undefined => {
  // Preferred rank matters here more than anywhere: a party often carries its
  // formal initialism and its everyday one, and only the ranking separates
  // them. Sweden's Social Democrats are "SAP" (Sveriges socialdemokratiska
  // arbetareparti) and "S" — and every Swede, every ballot paper and every
  // seating chart says S, which is the statement Wikidata marks preferred.
  const statement = currentStatement(entity?.claims?.P1813)
  const raw = statement?.mainsnak?.datavalue?.value
  const text = (raw as { text?: string } | undefined)?.text
  return text && text.trim().length <= 24 ? text.trim() : undefined
}

/** The `|logo=` filename on a party's own article, unwrapped from its markup. */
const logoFromArticle = async (title: string): Promise<string | undefined> => {
  const { getArticle } = await import('./net/wiki')
  const page = await getArticle(title)
  const raw = /^\s*\|\s*logo\s*=\s*(.+)$/im.exec(page?.wikitext ?? '')?.[1]
  if (!raw) return undefined
  const file = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-z]+[^>]*>/gi, '')
    .replace(/\{\{\s*!\s*\}\}[\s\S]*$/, '')
    .replace(/\[\[\s*(?:File|Image)\s*:/i, '')
    .replace(/\|[\s\S]*$/, '')
    .replace(/[[\]]/g, '')
    .replace(/^\s*(?:File|Image)\s*:/i, '')
    .trim()
  return /\.(?:svg|png|jpe?g|gif|webp)$/i.test(file) ? file : undefined
}

const SPECTRUM_BY_LABEL: [RegExp, SpectrumBand][] = [
  [/far[- ]left|radical left/i, 'left'],
  [/centre[- ]left|center[- ]left/i, 'centre_left'],
  [/centre[- ]right|center[- ]right/i, 'centre_right'],
  [/far[- ]right|right[- ]wing extremism/i, 'right'],
  [/left[- ]wing/i, 'left'],
  [/right[- ]wing/i, 'right'],
  [/centrism|centre|center|big tent|syncretic/i, 'centre'],
]

/**
 * Whether a row is somebody's party, as the model that read it judged.
 *
 * This used to be a regex over the name, and a name cannot carry the
 * distinction: Latvia seats a party called "Independence", and 142 entries are
 * named like blocs while being ordinary parties. The model sees the row, its
 * neighbours and the country, which is what the judgement actually needs. The
 * name pattern survives only as a fallback for rows extracted before `kind`
 * existed.
 */
const LOOKS_RESIDUAL =
  /^(others?|independents?|vacant|non[- ]attached|unaffiliated|crossbench|blank|total|speaker)$/i

const isResidual = (bloc: { name: string; kind?: string }): boolean =>
  bloc.kind ? bloc.kind === 'residual' || bloc.kind === 'independents' : LOOKS_RESIDUAL.test(bloc.name.trim())

const kindOf = (
  name: string,
  entity: Parameters<typeof labelOf>[0],
  claimed?: string
): BlocKind => {
  // The model's reading first — it had the row in context.
  if (claimed === 'residual' || claimed === 'independents') return claimed
  if (LOOKS_RESIDUAL.test(name.trim())) {
    return /independent/i.test(name) ? 'independents' : 'residual'
  }
  // The CLASS decides, never the name.
  //
  // 142 entries are named like blocs — "New Flemish Alliance", "National
  // Liberation Front of Angola", "Centre Alliance", "Democratic Front" — and
  // Wikidata files them as ordinary parties, which they are. A name-based
  // guess would have relabelled every one of them, and "which party governs?"
  // would then have no answer in a dozen countries that have a perfectly good
  // one. Where the class is silent, a party is the safer default: calling a
  // real party an alliance removes it from the question, where the reverse
  // merely leaves a bloc slightly overstated.
  const classes = openClaimIds(entity, 'P31')
  // Q7278 political party; Q10647343 political alliance; Q1418047 electoral list
  if (classes.includes('Q7278')) return 'party'
  if (classes.includes('Q10647343') || classes.includes('Q1418047')) return 'electoral_alliance'
  // Where Wikidata is silent, the model's reading stands.
  if (claimed === 'electoral_alliance' || claimed === 'parliamentary_group') return claimed
  return 'party'
}

/**
 * A party's logo, from Wikidata's P154 or, failing that, its own article.
 *
 * Andorra Forward is the case that forced the fallback: Q116465504 carries no
 * P154 at all, while its article names "Logo of the Andorra Forward.svg"
 * perfectly clearly. Measured, roughly a quarter of party items are like this —
 * the mark exists and nobody has linked it to the entity.
 *
 * The file is very often FAIR USE, hosted on en.wikipedia because Commons will
 * not take a trademarked emblem. That is not a reason to drop it: the pointer
 * is published with `non_free` and the licence beside it, and each consumer
 * applies its own policy. Refusing here would decide for all of them.
 */
const logoOf = async (
  entity: Parameters<typeof labelOf>[0],
  article?: string
): Promise<ImageRef | undefined> => {
  // Preferred rank: a party that has rebranded carries both marks, and the
  // superseded one is exactly what nobody would recognise.
  const logoStatement = currentStatement(entity?.claims?.P154)
  let file =
    (logoStatement?.mainsnak?.datavalue?.value as string | undefined) ??
    claimStrings(entity, 'P154')[0]
  if (!file && article) file = await logoFromArticle(article)
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
 * Resolve a bloc's wikilink to a Wikidata entity.
 *
 * The article title is the join key, not the display name — "Labour" and
 * "Labour Party (Norway)" are the same party and only the second resolves.
 * This is the whole reason the extractor is asked for `article`.
 */
const resolveArticles = async (titles: string[]): Promise<Map<string, QID>> => {
  const found = new Map<string, QID>()
  const unique = [...new Set(titles)].filter(Boolean)
  for (let index = 0; index < unique.length; index += 40) {
    const batch = unique.slice(index, index + 40)
    const url =
      `https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&ppprop=wikibase_item` +
      `&titles=${encodeURIComponent(batch.join('|'))}&format=json&redirects=1`
    const { fetchJson } = await import('./net/wiki')
    const data = await fetchJson<{
      query?: {
        normalized?: { from: string; to: string }[]
        redirects?: { from: string; to: string }[]
        pages?: Record<string, { title?: string; pageprops?: { wikibase_item?: string } }>
      }
    }>(url)
    // Follow normalisation and redirects back to the title we asked for.
    const alias = new Map<string, string>()
    for (const step of [...(data?.query?.normalized ?? []), ...(data?.query?.redirects ?? [])]) {
      alias.set(step.to, step.from)
    }
    for (const page of Object.values(data?.query?.pages ?? {})) {
      const qid = page.pageprops?.wikibase_item
      if (!qid || !page.title) continue
      let title: string | undefined = page.title
      const chain = new Set<string>()
      while (title && !chain.has(title)) {
        found.set(title, qid as QID)
        chain.add(title)
        title = alias.get(title)
      }
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// One country
// ---------------------------------------------------------------------------

interface BuildResult {
  polity?: Polity
  omission?: { iso: string; reason: string }
}

/** Wikitext leftovers that mean the field held no readable name. */
const NOT_A_NAME = /^\s*$|\{\{|^(prime minister|president|monarch|king|queen|chancellor|premier|vacant|tbd|none)\b/i

/**
 * Fold a name for comparison: diacritics out, letters only.
 *
 * Transliterations differ by insertions as often as substitutions —
 * Toqaev/Tokayev, Déby/Deby — so names are compared on their letters with a
 * small edit budget rather than exactly.
 */
const foldName = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

const nearlyEqual = (a: string, b: string): boolean => {
  if (a === b || a.includes(b) || b.includes(a)) return true
  if (Math.abs(a.length - b.length) > 3) return false
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous = row
  }
  return previous[b.length]! <= Math.max(2, Math.floor(Math.min(a.length, b.length) / 4))
}

const sameHuman = (a: string, b: string): boolean => {
  const left = foldName(a)
  const right = foldName(b)
  if (!left.length || !right.length) return false
  return left.some(word => right.some(other => nearlyEqual(word, other)))
}

/**
 * Put the article's name into the record.
 *
 * Same person: nothing to do — the structured entry already describes them.
 * Different person: the name replaces the entry, and every structured field
 * describing the PREVIOUS holder goes with it. Keeping a start date, portrait
 * or party from the person who left would attach one person's biography to
 * another's name, which is worse than having none.
 */
const applyNamedLeader = (
  held: OfficeHolder | null,
  claimed: string | undefined,
  source: { article: string; revid: number },
  retrieved: string
): void => {
  if (!held || !claimed || NOT_A_NAME.test(claimed.trim())) return
  const name = claimed.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name || sameHuman(held.name, name)) return

  held.name = name
  held.superseded = true
  delete held.since
  delete held.born_year
  delete held.portrait
  delete held.office
  held.party = null
  held.person = { qid: held.person.qid }
  held.provenance = {
    kind: 'wikipedia',
    derivation: 'extracted',
    article: source.article,
    revid: source.revid,
    retrieved_at: retrieved,
    model: 'claude-haiku-4-5',
  }
}

const buildCountry = async (
  iso: string,
  countryQid: QID,
  countryName: string,
  countryArticle?: string
): Promise<BuildResult> => {
  const retrieved = today()
  let contested = false
  let vacantContested = false
  let rivalAuthorities: string[] = []
  const countryEntity = (await getEntities([countryQid], 'claims|labels'))[countryQid]
  // "Ethiopian", "Guinean", "Swedish" — what an election article is named for.
  const demonym = ((countryEntity?.claims?.P1549 ?? [])
    .map(statement => statement.mainsnak?.datavalue?.value as { text?: string; language?: string })
    .find(value => value?.language === 'en')?.text ?? '').trim()
  const { form: declaredForm, form_raw } = await governmentForm(countryEntity)
  // The country article's own `government_type` prose, which says what P122
  // cannot: "under a military junta", "one-party ... totalitarian
  // dictatorship". It is preferred wherever the structured route could not
  // classify the state, and wherever it names a REGIME the structured route
  // has no vocabulary for — a junta is not a flavour of presidential republic,
  // it is the fact that displaces it.
  // Prose WINS wherever it parses.
  //
  // It is written as one considered sentence on a heavily watched page —
  // "Federal parliamentary republic", "Unitary presidential republic under a
  // military junta" — where P122 is an unordered pile of overlapping labels
  // that must be guessed between. Gating the prose behind "only when the
  // structured route failed" kept India as a presidential republic on the
  // strength of "constitutional republic", while its own article said
  // parliamentary in as many words.
  const prose = countryArticle ? await governmentTypeLine(countryArticle) : undefined
  const proseForm = formFromProse(prose)
  const startingForm = proseForm ?? declaredForm

  // Prose states the system outright; P122's vaguer labels are inferred.
  const leaders = await leadersOf(countryQid, startingForm, retrieved, !!proseForm)
  // The office arrangement can correct the label — see `leadersOf`.
  const form = leaders.form

  // THE FRESHNESS CHECK. A country's own article is the most-watched page it
  // has: measured across twelve states, every one had been edited within four
  // days, and it named the correct leader in every case — including Chad's
  // Allamaye Halina and Iraq's Nizar Amidi, which both structured routes miss
  // by years.
  //
  // It does not REPLACE the structured data, which carries the Q-ids, dates and
  // portraits an infobox line cannot. It arbitrates: where the article names
  // somebody else, the structured record is the stale one, and saying so is
  // more useful than silently shipping a leader who left in 2021.
  // THE ARTICLE IS THE SOURCE OF WHO HOLDS OFFICE.
  //
  // This started as a cross-check that flagged disagreements, and flagging was
  // the wrong shape: 20 records ended up holding the correct successor in a
  // `succeeded_by` field while still presenting the departed person as the
  // officeholder. Chad shipped Idriss Déby, dead since 2021, with "Allamaye
  // Halina" sitting in the record beside him.
  //
  // The country's article is simply the better source — measured across every
  // country that was wrong, it had been edited within days and named the
  // current holder. So it NAMES the officeholder, and Wikidata supplies what a
  // name cannot: the entity id, the start date, the portrait, the party. Where
  // the two agree, the record is whole. Where they disagree, the name wins and
  // the structured detail is dropped rather than misattributed to somebody it
  // does not describe.
  const lines = countryArticle ? await leaderLines(countryArticle) : undefined
  if (lines) {
    const named = await extractLeaders(hashOf(lines.text), lines.text, countryName)
    if (named) {
      applyNamedLeader(leaders.head_of_state, named.head_of_state, lines, retrieved)
      if (!named.same_person) {
        applyNamedLeader(leaders.head_of_government, named.head_of_government, lines, retrieved)
      }
      for (const claim of named.claimants ?? []) {
        const target =
          claim.office === 'head_of_state' ? leaders.head_of_state : leaders.head_of_government
        if (!target || !claim.name) continue
        target.contested_by = [
          ...(target.contested_by ?? []),
          { name: claim.name, ...(claim.authority ? { authority: claim.authority } : {}) },
        ]
      }
      if (named.disputed) contested = true
      if (named.vacant_contested) vacantContested = true
      rivalAuthorities = [
        ...new Set(
          (named.claimants ?? [])
            .map(claim => claim.authority)
            .filter((authority): authority is string => !!authority)
        ),
      ]
    }
  }

  if (!leaders.head_of_state) {
    return { omission: { iso, reason: 'no head of state resolved' } }
  }

  const chamberRefs = await chambersOf(countryQid)
  if (!chamberRefs.length) {
    return { omission: { iso, reason: 'no legislature resolved' } }
  }

  const parties: Record<string, Party> = {}
  const chambers: Chamber[] = []

  for (const ref of chamberRefs) {
    let blocs: ExtractedBloc[] = []
    let sourceHash = ''
    let article: string | undefined
    let revid: number | undefined
    let precise = false
    let statedSeats: number | undefined
    let description: string | undefined
    let lastElection: string | undefined
    let nextElection: string | undefined

    if (ref.article) {
      const source = await chamberSource(ref.article)
      if (source) {
        sourceHash = source.hash
        article = source.article
        revid = source.revid
        precise = source.precise
        statedSeats = source.seats
        const extraction = await extractComposition(source.hash, source.text, {
          chamber: ref.name,
          country: countryName,
          ...(ref.seats_total ? { seats: ref.seats_total } : {}),
        })
        if (extraction?.legible) {
          blocs = extraction.blocs
          description = extraction.description
        }
        // Dates are worth keeping even from an illegible composition: a
        // chamber we cannot seat is exactly one whose staleness matters most.
        lastElection = normaliseDate(extraction?.last_election)
        nextElection = normaliseDate(extraction?.next_election)
      }
    }

    // Resolve every linked bloc to an entity in one batch per chamber.
    //
    // Where the markup carries no wikilink the NAME is tried as an article
    // title, which is the same lookup with a weaker key. India's Lok Sabha is
    // the case: its composition template writes party names as plain text, so
    // 240 seats of Bharatiya Janata Party arrived with no article and would
    // otherwise carry no ideology, colour or logo at all. Wikipedia's own
    // redirect resolution does the work — a party's common name almost always
    // redirects to its article.
    const linked = blocs.map(bloc => bloc.article).filter((title): title is string => !!title)
    // The NAME is tried alongside the link, not only in its absence.
    //
    // A wikilink the model reports can simply not exist — Lithuania's Homeland
    // Union came back as "Homeland Union (2020)", which resolves to nothing,
    // while the bare "Homeland Union" is a real article. Falling back only when
    // `article` was ABSENT left 28 seats of a major opposition party unlinked.
    const byName = blocs.filter(bloc => !isResidual(bloc)).map(bloc => bloc.name)
    const byTitle = await resolveArticles([...linked, ...byName])
    const partyQids = [...new Set([...byTitle.values()])]
    const partyEntities = partyQids.length
      ? await getEntities(partyQids, 'claims|labels')
      : {}

    const alignmentIds = partyQids.flatMap(qid => openClaimIds(partyEntities[qid], 'P1387'))
    const ideologyIds = partyQids.flatMap(qid => openClaimIds(partyEntities[qid], 'P1142'))
    const groupingIds = partyQids.flatMap(qid => openClaimIds(partyEntities[qid], 'P463'))
    const labelEntities = await getEntities(
      [...new Set([...alignmentIds, ...ideologyIds, ...groupingIds])],
      'labels'
    )
    const named = (id: string): Entity => {
      const label = labelOf(labelEntities[id])
      return { qid: id as QID, ...(label ? { label } : {}) }
    }

    const seated = blocs.reduce((sum, bloc) => sum + bloc.seats, 0)
    // Wikidata's declared size is the DEFAULT, not the authority.
    //
    // P1342 goes stale where a chamber is resized: Mongolia's State Great
    // Khural still reads 76 where it now seats 126, and India's Lok Sabha 545
    // where the constitutional figure is 543. When a clean reading of the
    // article disagrees with it, the reading is the better evidence — it came
    // from a page an editor maintains, where P1342 is a number nobody revisits.
    //
    // "Clean" is doing the work: only a composition that looks internally
    // sound (enough rows, a plausible total) may overrule the declared size.
    // Otherwise a truncated read would silently redefine the chamber to
    // whatever it managed to find.
    // The chamber's own article states its size, and that is the best source
    // there is. Wikidata's P1342 goes stale wherever a chamber is resized and
    // nobody revisits the statement — 67 for a 79-seat Maltese parliament, 575
    // for Indonesia's 580, 104 for Eritrea's 150, 181 for a Dáil of 174, 545
    // for a Lok Sabha of 543 — while the article was right in every case.
    //
    // Failing that, a clean reading of the composition beats a contradicted
    // P1342: enough rows to look complete, and a total that disagrees.
    const declared = ref.seats_total ?? 0
    const trustReading =
      seated > 0 &&
      blocs.length >= 3 &&
      (declared === 0 || Math.abs(seated - declared) / declared > 0.02)
    const seatsTotal = statedSeats ?? (trustReading ? seated : declared || seated)
    // Share is of the seats actually SEATED, not the declared size.
    //
    // The two disagree whenever a chamber's reading overruns its P1342 —
    // Thailand's Senate seats 1.33x its declared total in the source — and
    // dividing by the smaller number produced shares above 1.0, which is not a
    // share of anything. The declared size is still what `confidence` is judged
    // against, so the disagreement stays visible rather than being papered over.
    const shareBase = Math.max(seated, seatsTotal)

    const composition: Seating[] = []
    for (const bloc of blocs) {
      // A residual row is never a party, however confidently the model links
      // it: "Independent" pointed at the ENTITY for independent politician,
      // which put a non-party in the registry and made 421 seats of
      // independents look like one organisation.
      const residual = isResidual(bloc)
      const qid = residual
        ? undefined
        : (bloc.article ? byTitle.get(bloc.article) : undefined) ?? byTitle.get(bloc.name)
      if (qid && !parties[qid]) {
        const entity = partyEntities[qid]
        // A party that has moved on the spectrum carries its history here, so
        // the current statement is the one that describes it today.
        const alignmentStatement = currentStatement(entity?.claims?.P1387)
        const alignmentId =
          (alignmentStatement?.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id ??
          openClaimIds(entity, 'P1387')[0]
        const alignmentLabel = alignmentId ? labelOf(labelEntities[alignmentId]) : undefined
        const band = alignmentLabel
          ? SPECTRUM_BY_LABEL.find(([pattern]) => pattern.test(alignmentLabel))?.[1]
          : undefined
        const founded = currentStatement(entity?.claims?.P571)
        const foundedYear = founded
          ? Number(
              String(
                (founded.mainsnak?.datavalue?.value as { time?: string } | undefined)?.time ?? ''
              ).slice(1, 5)
            )
          : undefined
        const english = labelOf(entity) ?? bloc.name
        const endonym = endonymOf(entity, english)
        const abbreviation = abbreviationOf(entity)
        parties[qid] = {
          entity: { qid, ...(labelOf(entity) ? { label: labelOf(entity)! } : {}) },
          name: english,
          ...(endonym ? { endonym } : {}),
          ...(abbreviation ? { abbreviation } : {}),
          kind: kindOf(bloc.name, entity, bloc.kind),
          ...(band ? { alignment: band } : {}),
          ...(alignmentLabel ? { alignment_raw: alignmentLabel } : {}),
          ideologies: openClaimIds(entity, 'P1142').slice(0, 6).map(named),
          groupings: openClaimIds(entity, 'P463').slice(0, 6).map(named),
          colors: claimStrings(entity, 'P465')
            .filter(value => HEX.test(value))
            .map(value => `#${value.toLowerCase()}`),
          ...(foundedYear && foundedYear > 1700 ? { founded_year: foundedYear } : {}),
          provenance: { kind: 'wikidata', derivation: 'structured', qid, retrieved_at: retrieved },
        }
        const logo = await logoOf(entity, bloc.article ?? bloc.name)
        if (logo) parties[qid]!.logo = logo
      }
      composition.push({
        party: qid ?? null,
        name: bloc.name,
        seats: bloc.seats,
        share: shareBase > 0 ? Number((bloc.seats / shareBase).toFixed(4)) : 0,
        standing: bloc.standing,
        ...(bloc.alliance ? { alliance: bloc.alliance } : {}),
      })
    }

    const mandate = mandateOf(lastElection, nextElection, ref.term_years, new Date())

    // Second pass: has an election happened since the one this composition
    // describes? A single read of the chamber's article cannot know — it has
    // nothing to compare against — so the election articles are asked directly.
    const newer =
      demonym && ref.role !== 'upper'
        ? await electionSince(demonym, lastElection ?? undefined)
        : undefined
    const unresolved = blocs.filter(bloc => !isResidual(bloc) && !byTitle.get(bloc.article ?? '') && !byTitle.get(bloc.name)).length
    // The SAME tolerance the validator applies, so a chamber can never be
    // called `high` and then fail its own sum check — an inconsistency that
    // would make `confidence` meaningless.
    const sumsMatch = seatsTotal > 0 && Math.abs(seated - seatsTotal) / seatsTotal <= 0.02
    // A composition older than its own chamber's mandate is not a high
    // confidence record however cleanly it parsed. Sudan's shipped a 426-seat
    // parliament dissolved in 2019, governed by a party banned the same year,
    // marked `high` — because the seats summed and the rows resolved. Age is
    // the check those two cannot make.
    // A composition with no election date behind it cannot be dated at all, and
    // an undatable composition is not a high-confidence one — Sudan's upper
    // house shipped `high` with no vintage whatsoever. `partial` is the honest
    // ceiling: the seats may be right, and nothing here can say when they were.
    // A sum that matches proves less than it looks.
    //
    // Every row a chamber lists is checked against its declared size, and a
    // composition can satisfy that while naming almost nobody: nine chambers
    // reported a full seat count made entirely of "Independent" and "Vacant",
    // and six of them were marked `high` on the strength of the arithmetic.
    // Naming no party is not a confident description of a parliament, however
    // exactly the seats add up.
    const namedParties = blocs.filter(bloc => !isResidual(bloc)).length
    const residualSeats = blocs
      .filter(bloc => isResidual(bloc))
      .reduce((sum, bloc) => sum + bloc.seats, 0)
    const mostlyResidual = seated > 0 && residualSeats / seated >= 0.5

    const expired = mandate?.state === 'overdue'
    const undated = !lastElection
    const confidence: Confidence = !blocs.length
      ? 'flagged'
      : !sumsMatch || expired || !namedParties || newer
        ? 'flagged'
        : unresolved > 0 || !precise || undated || mostlyResidual
          ? 'partial'
          : 'high'

    chambers.push({
      entity: { qid: ref.qid, label: ref.name },
      role: ref.role,
      name: ref.name,
      ...(ref.name_local ? { name_local: ref.name_local } : {}),
      seats_total: seatsTotal,
      selection: ref.role === 'upper' ? ['indirectly_elected'] : ['directly_elected'],
      contestation: contestationOf(form, ref, blocs),
      composition,
      ...(lastElection ? { last_election: lastElection } : {}),
      ...(nextElection ? { next_election: nextElection } : {}),
      ...(ref.term_years ? { term_years: ref.term_years } : {}),
      ...(mandate ? { mandate } : {}),
      // The election the composition describes, NOT the day we read it.
      as_of: lastElection ?? retrieved,
      retrieved_at: retrieved,
      ...(newer ? { superseded_by_election: newer } : {}),
      confidence,
      provenance: {
        kind: 'wikipedia',
        derivation: blocs.length ? 'extracted' : 'structured',
        ...(article ? { article } : {}),
        ...(revid ? { revid } : {}),
        retrieved_at: retrieved,
        ...(blocs.length ? { model: 'claude-haiku-4-5' } : {}),
      },
      source_hash: sourceHash,
    })
    if (description) chambers[chambers.length - 1]!.provenance.derivation = 'extracted'
  }

  // Government: the lower or only house is what forms one.
  const primary =
    chambers.find(chamber => chamber.role === 'lower') ??
    chambers.find(chamber => chamber.role === 'unicameral') ??
    chambers[0]!
  // A party belongs to ONE side. Sources split a bloc across rows — Sweden's
  // Democrats appear as 2 seats in government and 70 supporting it, which put
  // the same Q-id in `governing` AND `backing` and implied the party is both
  // in cabinet and outside it.
  //
  // The LARGER row decides which side the party is on, and the seats stay
  // where the source put them.
  //
  // Sweden's Democrats read 2 seats in government and 70 supporting it; the 70
  // is the party and the 2 is a rounding of the source's own markup. Taking
  // government as the stronger claim moved all 72 into the cabinet and made a
  // confidence-and-supply arrangement look like a coalition — the exact
  // distinction `backing` exists to preserve. Trusting the bigger row instead
  // keeps SD outside the government, where it belongs, and keeps the seat
  // total honest.
  const sideOf = new Map<QID, 'government' | 'backing'>()
  const largest = new Map<QID, number>()
  for (const row of primary.composition) {
    if (!row.party || (row.standing !== 'government' && row.standing !== 'backing')) continue
    if (row.seats >= (largest.get(row.party) ?? -1)) {
      largest.set(row.party, row.seats)
      sideOf.set(row.party, row.standing)
    }
  }
  const sideFor = (row: Seating) =>
    row.party ? (sideOf.get(row.party) ?? row.standing) : row.standing
  const governingRows = primary.composition.filter(
    row => (row.standing === 'government' || row.standing === 'backing') && sideFor(row) === 'government'
  )
  const backingRows = primary.composition.filter(
    row => (row.standing === 'government' || row.standing === 'backing') && sideFor(row) === 'backing'
  )
  const governmentSeats = governingRows.reduce((sum, row) => sum + row.seats, 0)
  const backedSeats = governmentSeats + backingRows.reduce((sum, row) => sum + row.seats, 0)

  const government: Government = {
    governing: governingRows.map(row => row.party).filter((qid): qid is QID => !!qid),
    backing: backingRows.map(row => row.party).filter((qid): qid is QID => !!qid),
    seats: governmentSeats,
    ...(backedSeats > governmentSeats ? { seats_with_backing: backedSeats } : {}),
    minority: primary.seats_total > 0 && governmentSeats * 2 <= primary.seats_total,
    // How firmly this government holds the state, as the source describes it.
    //
    // A NAMED rival authority is the strongest evidence there is — Sudan's
    // "Government of Peace and Unity", Yemen's Supreme Political Council are
    // not factions inside a government, they are competing claims to be it.
    // An office nobody can be named for because rivals claim it (Libya's
    // premiership) says the same thing.
    //
    // Never inferred from conflict alone: a country can be at war and still
    // have one uncontested government, and calling that `rival_governments`
    // would be a political judgement the data does not support.
    authority: rivalAuthorities.length
      ? 'rival_governments'
      : vacantContested
        ? 'rival_governments'
        : contested
          ? 'contested'
          : 'established',
    // A contested office is a flagged government however clean the seats are:
    // Sudan's article says the presidency is "Disputed by Hemedti of the RSF",
    // which is the single most important fact about who governs there.
    // A leader whose name had to be taken from prose, or an office somebody
    // else claims, is a government we cannot describe confidently.
    confidence:
      !governingRows.length ||
      contested ||
      leaders.head_of_state?.superseded ||
      leaders.head_of_government?.superseded
        ? 'flagged'
        : primary.confidence,
    provenance: {
      kind: 'wikipedia',
      derivation: 'derived',
      ...(primary.provenance.article ? { article: primary.provenance.article } : {}),
      retrieved_at: retrieved,
    },
  }

  return {
    polity: {
      iso,
      entity: { qid: countryQid, label: countryName },
      name: countryName,
      form,
      form_raw: prose ? [...form_raw, prose] : form_raw,
      head_of_state: leaders.head_of_state,
      head_of_government: leaders.head_of_government,
      parties,
      chambers,
      government,
      sources: [
        { kind: 'wikidata', derivation: 'structured', qid: countryQid, retrieved_at: retrieved },
      ],
      updated_at: retrieved,
    },
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export const build = async (only?: string[]): Promise<PolityDataset> => {
  const states = await unMemberStates()
  const wanted = only?.length ? states.filter(state => only.includes(state.iso)) : states
  const countries: Record<string, Polity> = {}
  const omissions: PolityDataset['omissions'] = []

  let done = 0
  for (const state of wanted) {
    try {
      const result = await buildCountry(state.iso, state.qid, state.name, state.article)
      if (result.polity) countries[state.iso] = result.polity
      if (result.omission) omissions.push(result.omission)
    } catch (error) {
      omissions.push({ iso: state.iso, reason: `build failed: ${String(error).slice(0, 120)}` })
    }
    done++
    if (done % 5 === 0 || done === wanted.length) {
      process.stdout.write(`\r  ${done}/${wanted.length} countries`)
    }
  }
  process.stdout.write('\n')

  return {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    countries,
    omissions,
  }
}
