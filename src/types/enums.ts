/**
 * Every closed vocabulary in the dataset.
 *
 * These are `as const` arrays with a derived union rather than TypeScript
 * `enum`s: the array is needed at runtime anyway (to validate a parsed value
 * and to emit the OpenAPI `enum` list), and a real `enum` would give a second,
 * separate declaration that has to be kept in step with it.
 *
 * A value is added here only when it is a JUDGEMENT the dataset makes. Where
 * the source has its own vocabulary — Wikidata's ideology labels, a chamber's
 * own name — that string is carried verbatim beside a Q-id instead, because a
 * closed list we invented would quietly drop whatever it failed to anticipate.
 */

// ---------------------------------------------------------------------------
// Where a party stands in relation to the government
// ---------------------------------------------------------------------------

/**
 * Confidence-and-supply is why this is not a boolean.
 *
 * Sweden's government is M+KD+L; the Sweden Democrats hold no ministries but
 * supply the majority. Filing them as government overstates them and filing
 * them as opposition is simply false, so they get their own standing. Norway's
 * Storting article writes the same relationship as a "Supported by (35)"
 * header, which is where the value is read from.
 *
 * `speaker` and `non_attached` exist because real chambers seat them and the
 * arithmetic does not balance without them — India's infobox carries a
 * "Vacant: (1)" row, and a presiding officer conventionally leaves their party
 * whip. Neither is a party's politics; both are a seat's status.
 */
export const STANDINGS = [
  /** Holds ministries — the government itself. */
  'government',
  /** Confidence and supply: props the government up, holds no ministries. */
  'backing',
  /** Everything left over, by construction. */
  'opposition',
  /** The presiding officer's seat, conventionally outside the party fight. */
  'speaker',
  /** Elected as no party's candidate, or left the party since. */
  'non_attached',
  /** A seat that exists and nobody currently holds. */
  'vacant',
] as const
export type Standing = (typeof STANDINGS)[number]

// ---------------------------------------------------------------------------
// Chambers
// ---------------------------------------------------------------------------

/**
 * A chamber's role in its legislature.
 *
 * Resolved from Wikidata's P31 walked UP the P279 subclass chain, never from an
 * exact class match: measured across 40 countries, the lower house is filed as
 * `Q375928` (lower house) in Germany, `Q2145277` (house of representatives) in
 * Australia, `Q320289` (chamber of deputies) in Brazil and `Q9247597` (house of
 * commons) in Britain and Canada — all of which subclass to `Q375928`. Matching
 * the exact id resolved 25 of 40; walking the chain resolves them all.
 */
export const CHAMBER_ROLES = [
  /** The only chamber. */
  'unicameral',
  /** The popularly elected house that forms governments. */
  'lower',
  /** The revising house — senate, house of lords, federal council. */
  'upper',
] as const
export type ChamberRole = (typeof CHAMBER_ROLES)[number]

/**
 * How competitive a chamber's seats actually are.
 *
 * North Korea's Supreme People's Assembly is a real building with real members
 * who really meet; what is fictional is the contest. Recording it as an
 * ordinary parliament would be false, and omitting the country would be worse —
 * it has a legislature and a composition, and a dataset that cannot say so is
 * incomplete precisely where the question is most interesting.
 *
 * So competitiveness is its own axis, orthogonal to structure. A chamber can be
 * bicameral, directly elected AND uncontested. The judgement is recorded once,
 * here, rather than leaking into `standing` (where "opposition" would become a
 * lie) or into omission.
 */
export const CONTESTATION = [
  /** Seats are won in elections the opposition can, and does, win. */
  'competitive',
  /** Elections occur and are meaningfully constrained — barred candidates,
   *  captured media, a ruling party that does not lose. */
  'restricted',
  /** A single party or front presents the only slate. Turnout and unanimity
   *  are reported near 100%; North Korea, Eritrea, Turkmenistan. */
  'uncontested',
  /** Members are appointed by a monarch or ruling council, not elected. */
  'appointed',
  /** The chamber exists in law and is not currently sitting — suspended,
   *  dissolved past its term, or displaced by emergency rule. */
  'suspended',
  /**
   * The source names no government and no opposition, and no bloc is large
   * enough for concentration to speak.
   *
   * A real value, not a gap. Tunisia, Kyrgyzstan and Liberia all arrive with
   * every party unaligned, and reading that silence as `competitive` would
   * assert a contest nothing recorded. A consumer can tell a measured verdict
   * from an absent one, which a default would hide.
   */
  'unknown',
] as const
export type Contestation = (typeof CONTESTATION)[number]

/** How a chamber's members arrive. Several may apply at once. */
export const SELECTION_METHODS = [
  'directly_elected',
  'indirectly_elected',
  'appointed',
  'hereditary',
  'ex_officio',
  'reserved',
] as const
export type SelectionMethod = (typeof SELECTION_METHODS)[number]

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

/**
 * The form of government, as a small closed set.
 *
 * Wikidata's P122 is NOT usable raw: measured, it returns unranked multi-values
 * mixing the current with the historical and the pejorative — South Africa
 * lists `apartheid`, Estonia `authoritarianism`, the United States five forms
 * at once. So P122 is read at preferred rank and then MAPPED onto this list,
 * with the raw labels kept beside it in `form_raw` for anyone who wants them.
 */
export const GOVERNMENT_FORMS = [
  'parliamentary_republic',
  'presidential_republic',
  'semi_presidential_republic',
  'constitutional_monarchy',
  'absolute_monarchy',
  'one_party_state',
  'theocracy',
  'military_junta',
  'transitional',
  /** Power is held by a party that permits no rival to take it, whatever the
   *  constitution says — China, North Korea, Eritrea. Distinct from
   *  `one_party_state` only in that a front of nominal parties may exist. */
  'dominant_party_state',
  'other',
] as const
export type GovernmentForm = (typeof GOVERNMENT_FORMS)[number]

/**
 * Which office speaks for the country, and where.
 *
 * A head of state and a head of government are different jobs that are
 * sometimes one person (El Salvador, the United States, South Africa) and
 * sometimes two (Britain, Germany, Japan). The dataset never merges them —
 * `head_of_government` is explicitly `null` when one person holds both, rather
 * than repeating the entry, so a consumer can tell "the same person" from
 * "we only found one".
 *
 * `represents` answers a question neither role settles on its own: Germany's
 * Chancellor attends the G7 while the President signs treaties, and Britain's
 * King is at the state banquet while the Prime Minister is in the negotiating
 * room. Ceremonial and political are the honest labels for that split.
 */
export const LEADER_ROLES = ['head_of_state', 'head_of_government'] as const
export type LeaderRole = (typeof LEADER_ROLES)[number]

export const REPRESENTATION = [
  /** Speaks for the state at home and abroad in a political capacity. */
  'political',
  /** Embodies the state — credentials, honours, state visits. */
  'ceremonial',
] as const
export type Representation = (typeof REPRESENTATION)[number]

// ---------------------------------------------------------------------------
// Party politics
// ---------------------------------------------------------------------------

/**
 * The five bands, as a reader understands them.
 *
 * Derived from Wikidata's P1387 rather than copied: its own vocabulary reads as
 * a database ("far-left politics", "syncretic politics", "right-wing
 * extremism"), and the raw label is kept in `alignment_raw` so nothing is lost
 * in the fold.
 *
 * Deliberately five and not seven. A "far-left"/"far-right" band invites a
 * judgement the source does not reliably support, and the parties it would
 * describe are already the ones whose classification is most contested.
 */
export const SPECTRUM_BANDS = ['left', 'centre_left', 'centre', 'centre_right', 'right'] as const
export type SpectrumBand = (typeof SPECTRUM_BANDS)[number]

/**
 * What kind of thing a seated bloc is.
 *
 * A chamber does not only seat parties. It seats electoral alliances that ran
 * as one list, parliamentary groups formed after the election, and rows that
 * are not organisations at all. Calling all of them "party" is what makes a
 * dataset lie: asking "which of these parties governs?" has no honest answer
 * when the answer is an alliance of five.
 */
export const BLOC_KINDS = [
  /** A single political party. */
  'party',
  /** Parties that contested the election on one list. */
  'electoral_alliance',
  /** A group formed inside the chamber after the election. */
  'parliamentary_group',
  /** Members elected as no party's candidate, counted together. */
  'independents',
  /** The chamber's own bookkeeping — "Others", "Vacant". */
  'residual',
] as const
export type BlocKind = (typeof BLOC_KINDS)[number]

// ---------------------------------------------------------------------------
// Provenance and trust
// ---------------------------------------------------------------------------

/**
 * How far a record should be trusted, stated in the data rather than a log.
 *
 * A consumer must be able to tell a verified row from a guessed one without
 * re-reading the source. `flagged` is not an error — the record is still the
 * best available reading — it is an instruction to show an asterisk.
 */
export const CONFIDENCE = [
  /** Seats sum to the declared total and every bloc resolved to an entity. */
  'high',
  /** Sound, with a gap: an unresolved bloc, or a sum inside tolerance. */
  'partial',
  /** Internally inconsistent — sums disagree, or the source contradicts itself. */
  'flagged',
] as const
export type Confidence = (typeof CONFIDENCE)[number]

/** Where a field came from, so a correction knows what to go and fix. */
export const SOURCE_KINDS = ['wikidata', 'wikipedia', 'ipu', 'manual'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/**
 * How a value was derived. This is the field that keeps the dataset honest
 * about the model: an LLM-extracted value and a Q-id lookup are not the same
 * kind of fact, and a consumer is entitled to know which it is holding.
 */
export const DERIVATIONS = [
  /** Read directly from a structured property. No interpretation. */
  'structured',
  /** Parsed deterministically from markup by a rule we wrote. */
  'parsed',
  /** Extracted from prose or markup by a language model, then validated. */
  'extracted',
  /** Computed from other fields in this record. */
  'derived',
  /** Entered by a human, overriding everything above. */
  'manual',
] as const
export type Derivation = (typeof DERIVATIONS)[number]
