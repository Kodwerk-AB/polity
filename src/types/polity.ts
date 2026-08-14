import type {
  BlocKind,
  ChamberRole,
  Confidence,
  Contestation,
  Derivation,
  GovernmentForm,
  Representation,
  SelectionMethod,
  SourceKind,
  SpectrumBand,
  Standing,
} from './enums'

/**
 * The shape of the world's governments.
 *
 * Three rules run through every type below, and they are the reason this is
 * worth publishing rather than scraping per-consumer:
 *
 *  1. EVERY entity carries its Wikidata Q-id beside its label. The label is for
 *     humans; the Q-id is the join key. String matching between sources is what
 *     fails — "Conservative People's Party" and "Conservative People's Party or
 *     DKF" are the same party and no string comparison says so.
 *  2. EVERY derived value carries its provenance. A Q-id lookup and a language
 *     model's reading of an infobox are both useful and are not the same kind
 *     of fact.
 *  3. NOTHING is silently omitted. A missing head of government is `null` with
 *     a reason; an unresolved bloc keeps its name and loses only its id.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO 3166-1 alpha-2, uppercase. The dataset's key. */
export type ISOCountryCode = string

/** A Wikidata entity id, `Q` followed by digits. */
export type QID = `Q${number}`

/** An ISO 8601 date, day precision. Coarser values are dropped, never padded. */
export type ISODate = string

/**
 * Any entity that exists in Wikidata, named for humans and keyed for machines.
 *
 * `label` is English and may be absent — a real entity with no English label is
 * still a valid join target, and inventing a translation would be worse.
 */
export interface Entity {
  qid: QID
  label?: string
}

/**
 * Where a value came from, and how much interpretation stands between the
 * source and the field.
 *
 * `revid` pins the EXACT revision read. Without it "we read Wikipedia" is
 * unfalsifiable; with it, a disagreement can be settled by fetching that
 * revision and looking.
 */
export interface Provenance {
  kind: SourceKind
  derivation: Derivation
  /** Wikidata entity, when the value came from one. */
  qid?: QID
  /** Wikipedia article title, when the value was read from one. */
  article?: string
  /** The exact revision read — the audit trail. */
  revid?: number
  /** When this value was last confirmed against its source. */
  retrieved_at: ISODate
  /** The model that extracted it, when `derivation` is `extracted`. */
  model?: string
}

/**
 * An image we point at but never re-host.
 *
 * The dataset publishes a POINTER plus the licence facts, so each consumer
 * applies its own policy: a public-domain mark and a fair-use one are both
 * listed, flagged differently, and it is the consumer that decides. Storing the
 * Commons FILENAME rather than a baked thumbnail URL survives file renames and
 * lets a consumer choose its own width.
 */
export interface ImageRef {
  /** The Commons/Wikipedia filename, without the `File:` prefix. */
  file: string
  /** Special:FilePath URL. Serves `Access-Control-Allow-Origin: *`. */
  url: string
  /** Which wiki actually hosts it — fair-use files never leave en.wikipedia. */
  host: 'commons' | 'wikipedia'
  /** As the host states it: "PD", "CC BY-SA 4.0", "Fair use". */
  license?: string
  /** The host serves it under fair use, not a licence grant. */
  non_free: boolean
  /** Commons' `Restrictions` note — "trademarked" for most party marks. */
  restrictions?: string
  /** The author the licence requires naming, when one is recorded. */
  credit?: string
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * A person holding an office.
 *
 * `party` is nullable and that is a fact, not a gap: heads of state
 * conventionally suspend party membership in several republics. But a leader
 * whose party is merely UNRESOLVED must not read the same way, so an
 * unresolvable party leaves `party: null` and lowers `confidence`.
 */
export interface OfficeHolder {
  person: Entity
  name: string
  /** The office itself — "President of El Salvador", as an entity. */
  office?: Entity
  /** Their party, or null when genuinely independent of one. */
  party: Entity | null
  /** When this term began. Day precision or absent — never a padded year. */
  since?: ISODate
  born_year?: number
  portrait?: ImageRef
  /** Whether this office speaks politically or ceremonially for the state. */
  represents: Representation
  /**
   * The source still names this person, and their own record says they left.
   *
   * A country's leadership statement is written when someone arrives and often
   * never closed when they go — Somalia names a prime minister who left in
   * 2022, Chad one who died in 2021. Their own article closes every position
   * they held, which is how the contradiction is caught.
   *
   * Set means the NAME came from the country's article because the structured
   * record named somebody who has left. The name is current; the fields that
   * would describe them — start date, portrait, party, entity id — are absent,
   * because those belonged to the previous holder and attaching them here would
   * give one person another's biography.
   */
  superseded?: boolean
  /**
   * Somebody else claims this office.
   *
   * A civil war is not a footnote on a leader — it is the central fact about
   * who governs, and a dataset that reduces it to a boolean cannot say
   * anything useful. Sudan's article names not just that the presidency is
   * disputed but WHO disputes it and under which rival authority; Yemen's
   * names the Supreme Political Council in Sanaa.
   *
   * Recorded on the office rather than the country because the split is rarely
   * total: Sudan's rivals contest the presidency, the sovereignty council and
   * the premiership separately, and Libya's two governments agree on nobody.
   */
  contested_by?: Claimant[]
  provenance: Provenance
}

/**
 * A rival claimant to an office.
 *
 * Deliberately thin. The dataset can say who is named and what they are named
 * as; it cannot adjudicate which claim is valid, and should not try. A consumer
 * that needs to pick one has more context than this file does.
 */
export interface Claimant {
  name: string
  /** The rival authority they hold the office under, when the source names one
   *  — Sudan's "Government of Peace and Unity", Yemen's Supreme Political
   *  Council. */
  authority?: string
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

/**
 * A political party as an organisation, independent of any seat count.
 *
 * Parties live in a country-level registry rather than inside a chamber,
 * because the same party sits in both houses and across successive elections.
 * A chamber's composition REFERENCES this by Q-id.
 */
export interface Party {
  entity: Entity
  /** The name in English, as the primary source gives it. */
  name: string
  /** The party's own name for itself, when it differs. */
  endonym?: string
  /** The short form a chart axis can carry — "AfD", "CDU". */
  abbreviation?: string
  /**
   * What kind of organisation this is. An electoral alliance is not a party,
   * and a dataset that calls it one cannot answer "which party governs?"
   * honestly.
   */
  kind: BlocKind
  /** The five-band fold of P1387, for sorting and colouring. */
  alignment?: SpectrumBand
  /** Wikidata's own alignment label, unfolded — "syncretic politics". */
  alignment_raw?: string
  /** Ideologies (P1142), most salient first, as entities. */
  ideologies: Entity[]
  /**
   * Transnational families this party belongs to (P463) — the EPP, the
   * Progressive Alliance, Socialist International. OPEN statements only: an
   * ended membership records that it USED to belong, which is not what
   * "member of the EPP" means.
   */
  groupings: Entity[]
  /** Party colours as `#rrggbb`. Validated hex — free-text values are dropped. */
  colors: string[]
  founded_year?: number
  /** Present only for a party that has dissolved; live parties omit it. */
  dissolved_year?: number
  logo?: ImageRef
  provenance: Provenance
}

// ---------------------------------------------------------------------------
// Chambers
// ---------------------------------------------------------------------------

/**
 * One bloc's seats in one chamber.
 *
 * `party` is a Q-id REFERENCE into the country's party registry, not an
 * embedded copy — the same party appears in both houses and duplicating it
 * invites the two to drift apart.
 */
export interface Seating {
  /** The party, when the bloc resolved to one. Null for residual rows. */
  party: QID | null
  /** As the chamber names it, always — even when `party` is null. */
  name: string
  seats: number
  /** Share of the chamber's total seats, 0–1. Computed, never parsed. */
  share: number
  standing: Standing
  /**
   * The national bloc this party stood in — Sweden's Red-Greens, Poland's
   * United Right. Real chambers seat allies together, so this is what orders a
   * hemicycle, and it explains a small party sitting where its size alone
   * would not put it.
   */
  alliance?: string
  /** Share of the national vote, when the source publishes one. */
  vote_share?: number
}

/**
 * One house of a legislature.
 *
 * ALWAYS an array element, even for a unicameral country. A consumer writes one
 * code path over `chambers` and never an `if (bicameral)` branch.
 */
export interface Chamber {
  entity: Entity
  role: ChamberRole
  /** English name — "House of Commons", "Bundestag". */
  name: string
  /** The chamber's own name for itself — "Asamblea Legislativa". */
  name_local?: string
  /** The chamber's full size. */
  seats_total: number
  /** How its members arrive. Several may apply to one chamber. */
  selection: SelectionMethod[]
  /**
   * How real the contest for these seats is. Orthogonal to everything else: a
   * chamber can be bicameral, directly elected AND uncontested. Recorded so a
   * consumer can show North Korea's Supreme People's Assembly honestly rather
   * than either omitting it or implying its 687 seats were fought over.
   */
  contestation: Contestation
  /**
   * Seats this election actually renewed, when it renewed only some. Its
   * presence means the composition describes THIS election, not the whole
   * sitting chamber — staggered senates are the case, and a share taken
   * against the full total understates every bloc.
   */
  seats_contested?: number
  composition: Seating[]
  last_election?: ISODate
  next_election?: ISODate
  /**
   * The constitutional term, in years (P2097 on the chamber).
   *
   * Kept beside the dates because it is what makes a MISSING `next_election`
   * usable: a chamber elected five years ago under a four-year term is overdue
   * whether or not anyone has written down when the next vote falls.
   */
  term_years?: number
  /**
   * How this chamber's mandate stands, derived from the dates above.
   *
   * This is the field that answers "might this data be about to go out of
   * date?" — the question that sank every previous attempt at this dataset.
   * mySociety gave up because "there is an election somewhere roughly once a
   * week"; a consumer that can see which countries are close to due can re-check the
   * handful that matter instead of re-reading all 193.
   */
  mandate?: MandateStatus
  /**
   * The vintage of the COMPOSITION — the election it describes, not the day
   * the pipeline ran.
   *
   * Every chamber used to carry the build date, which said the same thing about
   * Denmark's 2022 parliament and Eritrea's 1993 one: that both were current as
   * of today. That is the failure mode this dataset exists to avoid, and it was
   * being asserted 273 times.
   *
   * Falls back to the retrieval date only when no election date is known, which
   * is itself worth seeing.
   */
  as_of: ISODate
  /** When the pipeline last read the source. Distinct from `as_of`. */
  retrieved_at: ISODate
  confidence: Confidence
  provenance: Provenance
  /**
   * The cache key. A hash of the SOURCE FIELD the composition was read from,
   * not of the page: measured across 6 busy legislature articles and 120
   * revisions spanning 11–168 days, the composition field never changed once
   * while 18 of 20 pages were edited within 90 days. Gating a re-extraction on
   * the page's revision would re-run constantly; gating on this collapses it to
   * real elections.
   */
  source_hash: string
}

// ---------------------------------------------------------------------------
// Government
// ---------------------------------------------------------------------------

/**
 * Who actually rules, which is a different question from who won seats.
 *
 * Derived from the government side ONLY: opposition is everything left over, by
 * construction. That inversion matters because a source's "opposition" field is
 * populated for a fraction of countries while the seated blocs are held in
 * full, so deriving is both better covered and impossible to leave inconsistent
 * with the composition beside it.
 */
/**
 * How firmly one authority actually holds the state.
 *
 * Distinct from `contestation`, which is about a chamber's elections. This is
 * about the state itself: a country can hold perfectly competitive elections in
 * the territory it controls while a rival government runs the rest.
 */
export type Authority =
  /** One government, uncontested control. */
  | 'established'
  /** An office or two is claimed by a rival, but one authority governs. */
  | 'contested'
  /** Two or more governments claim the state — Libya, Yemen, Sudan. */
  | 'rival_governments'
  /** No effective national government. */
  | 'collapsed'

export interface Government {
  /** Parties holding ministries. */
  governing: QID[]
  /** Confidence and supply — props it up, holds no ministries. */
  backing: QID[]
  /** The cabinet as an entity, when it has an article of its own. */
  cabinet?: Entity
  /** Seats held by `governing` alone. */
  seats: number
  /** Seats including `backing`, when a supply deal carries it further. */
  seats_with_backing?: number
  /**
   * The government holds less than half the house. Computed from SEATS, never
   * from "has backers" — Denmark and Spain govern in a minority with no formal
   * supply deal at all.
   */
  minority: boolean
  /**
   * Whether this government's writ actually runs. `established` for most of
   * the world; anything else is a signal that "the government" is a contested
   * description rather than a settled fact.
   */
  authority: Authority
  /** How the source phrases it — "minority coalition government". */
  description?: string
  formed?: ISODate
  confidence: Confidence
  provenance: Provenance
}

// ---------------------------------------------------------------------------
// The country record
// ---------------------------------------------------------------------------

export interface Polity {
  iso: ISOCountryCode
  entity: Entity
  name: string
  /** The state's form, folded to a closed set. */
  form: GovernmentForm
  /** Every raw P122 label at preferred rank, unfolded. */
  form_raw: string[]
  /**
   * Head of state, always present for a sovereign state.
   * Head of government is `null` when the SAME PERSON holds both offices —
   * explicitly, rather than by repeating the entry, so "one person" is
   * distinguishable from "we only found one".
   */
  head_of_state: OfficeHolder
  head_of_government: OfficeHolder | null
  /** The country's parties, keyed by Q-id. Chambers reference these. */
  parties: Record<QID, Party>
  /** One entry for unicameral, two for bicameral. Never a different shape. */
  chambers: Chamber[]
  government: Government
  /** Everything read to build this record. */
  sources: Provenance[]
  updated_at: ISODate
}

/**
 * Where a chamber stands in its electoral cycle.
 *
 * Derived from `last_election`, `next_election` and `term_years` — never
 * asserted by a source, and absent when none of the three is known rather than
 * guessed at.
 */
export interface MandateStatus {
  /**
   * When the mandate is expected to end: `next_election` where the source gives
   * one, otherwise `last_election` plus `term_years`.
   *
   * An ABSOLUTE date on purpose. A "days remaining" count would be wrong the
   * morning after it was written — the file is rebuilt weekly, not daily — and
   * a consumer computing the difference against its own clock is always right.
   * The rule throughout: store what was true when the source said it, never
   * a number that decays silently between rebuilds.
   */
  expected_end?: ISODate
  /** True when `expected_end` was computed from the term rather than read. */
  inferred: boolean
  /**
   * `current` — comfortably inside its term.
   * `due_soon` — the mandate ends within a year of `as_of`.
   * `overdue` — past its expected end with no newer election recorded. A signal
   *   to re-check the source, not an accusation: a term can be legally extended.
   * `unknown` — no date and no term to reason from.
   *
   * Evaluated against the chamber's `as_of`, so it stays true of the moment the
   * data was gathered rather than drifting toward `overdue` on the shelf.
   */
  state: 'current' | 'due_soon' | 'overdue' | 'unknown'
}

/** The published file. */
export interface PolityDataset {
  /** Semver. A breaking change to any type above bumps the major. */
  schema_version: string
  generated_at: ISODate
  /** Keyed by ISO 3166-1 alpha-2. */
  countries: Record<ISOCountryCode, Polity>
  /** What did not make it in, and why — published, not logged. */
  omissions: {
    iso: ISOCountryCode
    reason: string
  }[]
}
