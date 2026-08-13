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
import { governmentForm, leadersOf } from './resolve/leaders'
import { chamberSource } from './extract/source'
import { extractComposition, type ExtractedBloc } from './extract/model'
import type { BlocKind, Confidence, Contestation, SpectrumBand } from './types/enums'
import type {
  Chamber,
  Entity,
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
const normaliseDate = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (full) {
    const year = Number(full[1])
    return year >= 1900 && year <= 2100 ? value.trim() : undefined
  }
  const year = /^(\d{4})$/.exec(value.trim())
  if (year) {
    const number = Number(year[1])
    return number >= 1900 && number <= 2100 ? `${year[1]}-07-01` : undefined
  }
  return undefined
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
const contestationOf = (
  form: Polity['form'],
  chamber: ChamberRef,
  blocs: ExtractedBloc[]
): Contestation => {
  if (chamber.dissolved) return 'suspended'
  const total = blocs.reduce((sum, bloc) => sum + bloc.seats, 0)
  const largest = blocs.reduce((most, bloc) => Math.max(most, bloc.seats), 0)
  const dominance = total > 0 ? largest / total : 0

  if (form === 'one_party_state' || form === 'dominant_party_state') {
    // A ruling party holding nearly everything, in a state that permits no
    // rival, is not a contest. North Korea's Workers' Party holds 671 of 687.
    return dominance >= 0.85 ? 'uncontested' : 'restricted'
  }
  if (form === 'absolute_monarchy' || form === 'theocracy') {
    return chamber.role === 'upper' ? 'appointed' : 'restricted'
  }
  if (form === 'military_junta' || form === 'transitional') return 'suspended'
  // An upper house nobody elects is appointed however competitive the state.
  if (chamber.role === 'upper' && !blocs.length) return 'appointed'
  return 'competitive'
}

/**
 * Where a chamber stands in its electoral cycle.
 *
 * The whole point of this field is early warning. Composition drifts the moment
 * an election happens, and the dataset cannot watch 193 countries continuously
 * — but it CAN say which ones are near the end of a term, so a consumer
 * re-checks the handful that matter rather than distrusting all of them.
 *
 * Everything is derived; nothing is asserted. With no dates and no term the
 * answer is `unknown`, which is honest and useful in a way a guess would not be.
 */
const mandateOf = (
  lastElection: string | undefined,
  nextElection: string | undefined,
  termYears: number | undefined,
  asOf: Date
): Polity['chambers'][number]['mandate'] => {
  const year = 365.25 * 86_400_000

  // A scheduled date is the best evidence there is. Failing that, the term
  // arithmetic answers; failing that, five years is the commonest term in the
  // world and the longest that is at all usual.
  let expected: Date | undefined
  let inferred = false
  if (nextElection) {
    expected = new Date(nextElection)
  } else if (lastElection) {
    expected = new Date(new Date(lastElection).getTime() + (termYears ?? 5) * year)
    inferred = true
  }

  if (!expected || Number.isNaN(expected.getTime())) {
    return lastElection || nextElection ? { inferred: false, state: 'unknown' } : undefined
  }

  const remaining = expected.getTime() - asOf.getTime()
  const state = remaining < 0 ? 'overdue' : remaining <= year ? 'due_soon' : 'current'
  return { expected_end: expected.toISOString().slice(0, 10), inferred, state }
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

const HEX = /^[0-9A-Fa-f]{6}$/

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

const NOT_A_PARTY =
  /^(others?|independents?|vacant|non[- ]attached|unaffiliated|crossbench|blank|total|speaker)$/i

const ALLIANCE_WORDS = /\b(alliance|coalition|bloc|front|union of|pact)\b/i

const kindOf = (name: string, entity: Parameters<typeof labelOf>[0]): BlocKind => {
  if (NOT_A_PARTY.test(name.trim())) {
    return /independent/i.test(name) ? 'independents' : 'residual'
  }
  const classes = openClaimIds(entity, 'P31')
  // Q7278 political party; Q10647343 political alliance; Q48204 association
  if (classes.includes('Q7278')) return 'party'
  if (classes.includes('Q10647343') || classes.includes('Q1418047')) return 'electoral_alliance'
  if (ALLIANCE_WORDS.test(name)) return 'electoral_alliance'
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
  let file = claimStrings(entity, 'P154')[0]
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

const buildCountry = async (
  iso: string,
  countryQid: QID,
  countryName: string
): Promise<BuildResult> => {
  const retrieved = today()
  const countryEntity = (await getEntities([countryQid], 'claims|labels'))[countryQid]
  const { form, form_raw } = await governmentForm(countryEntity)
  const leaders = await leadersOf(countryQid, form, retrieved)

  if (!leaders.head_of_state) {
    return { omission: { iso, reason: 'no head of state resolved' } }
  }
  // A leader taken from a CLOSED statement is the most recent holder, not a
  // confirmed incumbent — Colombia and Guinea-Bissau are mid-transition in the
  // source. Recorded, and marked, rather than omitted.
  const staleLeader =
    leaders.head_of_state.provenance.derivation === 'derived' ||
    leaders.head_of_government?.provenance.derivation === 'derived'

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
    const unlinked = blocs
      .filter(bloc => !bloc.article && !NOT_A_PARTY.test(bloc.name.trim()))
      .map(bloc => bloc.name)
    const byTitle = await resolveArticles([...linked, ...unlinked])
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

    const seatsTotal =
      ref.seats_total ?? blocs.reduce((sum, bloc) => sum + bloc.seats, 0) ?? 0
    const seated = blocs.reduce((sum, bloc) => sum + bloc.seats, 0)
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
      const qid = (bloc.article ? byTitle.get(bloc.article) : undefined) ?? byTitle.get(bloc.name)
      if (qid && !parties[qid]) {
        const entity = partyEntities[qid]
        const alignmentId = openClaimIds(entity, 'P1387')[0]
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
        parties[qid] = {
          entity: { qid, ...(labelOf(entity) ? { label: labelOf(entity)! } : {}) },
          name: labelOf(entity) ?? bloc.name,
          kind: kindOf(bloc.name, entity),
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
    const unresolved = composition.filter(row => !row.party && !NOT_A_PARTY.test(row.name)).length
    // The SAME tolerance the validator applies, so a chamber can never be
    // called `high` and then fail its own sum check — an inconsistency that
    // would make `confidence` meaningless.
    const sumsMatch = seatsTotal > 0 && Math.abs(seated - seatsTotal) / seatsTotal <= 0.02
    const confidence: Confidence = !blocs.length
      ? 'flagged'
      : !sumsMatch
        ? 'flagged'
        : unresolved > 0 || !precise
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
      as_of: retrieved,
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
  const governingRows = primary.composition.filter(row => row.standing === 'government')
  const backingRows = primary.composition.filter(row => row.standing === 'backing')
  const governmentSeats = governingRows.reduce((sum, row) => sum + row.seats, 0)
  const backedSeats = governmentSeats + backingRows.reduce((sum, row) => sum + row.seats, 0)

  const government: Government = {
    governing: governingRows.map(row => row.party).filter((qid): qid is QID => !!qid),
    backing: backingRows.map(row => row.party).filter((qid): qid is QID => !!qid),
    seats: governmentSeats,
    ...(backedSeats > governmentSeats ? { seats_with_backing: backedSeats } : {}),
    minority: primary.seats_total > 0 && governmentSeats * 2 <= primary.seats_total,
    confidence: !governingRows.length || staleLeader ? 'flagged' : primary.confidence,
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
      form_raw,
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
      const result = await buildCountry(state.iso, state.qid, state.name)
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
