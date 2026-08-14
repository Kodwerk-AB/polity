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

// ---------------------------------------------------------------------------
// Media and mandate
// ---------------------------------------------------------------------------

/** Which Wikimedia project hosts a file. */
export const IMAGE_HOSTS = ['commons', 'wikipedia'] as const
export type ImageHost = (typeof IMAGE_HOSTS)[number]

/**
 * Where a chamber stands in its term.
 *
 * `unknown` is a real answer, not a gap to be filled: a chamber with no known
 * election date and no term length cannot be placed in its cycle at all, and
 * saying so is better than implying it is current.
 */
export const MANDATE_STATES = ['current', 'due_soon', 'overdue', 'unknown'] as const
export type MandateState = (typeof MANDATE_STATES)[number]

/**
 * Commons' re-use restrictions, beyond the licence itself.
 *
 * A file can be freely licensed and still constrained — a party logo is
 * usually a trademark, and several countries restrict communist insignia.
 * These are Commons' own values, lowercased and split from its pipe-joined
 * string; `restrictions` is an ARRAY because a file commonly carries two.
 */
export const IMAGE_RESTRICTIONS = ['communist', 'insignia', 'trademarked'] as const
export type ImageRestriction = (typeof IMAGE_RESTRICTIONS)[number]

/**
 * How firmly one government actually holds the state.
 *
 * Distinct from `contestation`, which is about a chamber's ELECTIONS. This is
 * about the state itself: a country can hold perfectly competitive elections in
 * the territory it controls while a rival government runs the rest.
 */
export const AUTHORITIES = [
  /** One government, uncontested control. */
  'established',
  /** An office or two is claimed by a rival, but one authority governs. */
  'contested',
  /** Two or more governments claim the state — Libya, Yemen, Sudan. */
  'rival_governments',
  /** No effective national government. */
  'collapsed',
] as const
export type Authority = (typeof AUTHORITIES)[number]

// ---------------------------------------------------------------------------
// Ideology families
// ---------------------------------------------------------------------------

/**
 * The broad tradition an ideology belongs to.
 *
 * `ideologies` carries what Wikidata actually says about a party, and that is
 * a long tail: 409 distinct ideologies across 1,395 parties, 222 of them
 * appearing exactly once. The tail is the useful part — "Kemalism", "Basque
 * nationalism", "Pancasila", "socialism with Chinese characteristics" are
 * precisely what a reader cannot get anywhere else — so it is NOT folded away.
 *
 * This sits alongside it, for the questions the raw labels cannot answer:
 * "which parliaments seat a green party", "how many governments are led by
 * Christian democrats". A comparison across countries needs a closed
 * vocabulary; a description of one party needs the specific label. Both ship.
 *
 * A family is deliberately BROADER than a placement on a left-right axis —
 * that is what `alignment` is for. Nationalism spans both wings and gets its
 * own family rather than being forced onto a side.
 */
export const IDEOLOGY_FAMILIES = [
  /** Social democracy, democratic socialism, labourism, the Third Way. */
  'social_democratic',
  /** Communism, Marxism–Leninism, Trotskyism, anti-capitalism. */
  'socialist',
  /** Market liberalism, classical liberalism, libertarianism. */
  'liberal',
  /** Conservatism in its national, social and liberal variants. */
  'conservative',
  /** Christian democracy and confessional politics of any faith. */
  'religious',
  /** Green politics, environmentalism, eco-socialism. */
  'green',
  /** Nationalism, regionalism, separatism, irredentism — of any wing. */
  'nationalist',
  /**
   * A stance toward a supranational bloc or neighbour, rather than a domestic
   * tradition: pro-Europeanism, euroscepticism, Atlanticism, pan-movements.
   *
   * Its own family because folding it into `nationalist` made the Liberal
   * Democrats and the Green Party of England and Wales read as nationalist on
   * the strength of "pro-Europeanism" alone — a position most of the European
   * centre holds.
   */
  'internationalist',
  /** Populism, left or right; anti-establishment and anti-corruption politics. */
  'populist',
  /** Agrarian and rural-interest politics. */
  'agrarian',
  /** Authoritarianism, militarism, ultranationalism, one-party doctrine. */
  'authoritarian',
  /** Federalism, decentralisation, direct democracy, constitutional reform. */
  'reformist',
  /** Real, named, and outside every family above. */
  'other',
] as const
export type IdeologyFamily = (typeof IDEOLOGY_FAMILIES)[number]

/**
 * A state's standing in the international system.
 *
 * Absent means a UN member state, which is the overwhelming majority and the
 * default a consumer should assume. The rest are carried deliberately — a
 * dataset that silently omitted Taiwan's Legislative Yuan, one of Asia's most
 * competitive chambers, would be worse than one that includes it and says what
 * it is.
 */
export const RECOGNITION = [
  /** A UN observer state: the Vatican, Palestine. */
  'un_observer',
  /** Recognised by many states but holding no UN seat: Taiwan, Kosovo. */
  'partially_recognised',
] as const
export type Recognition = (typeof RECOGNITION)[number]

/**
 * Which office actually runs the government.
 *
 * Distinct from protocol rank, and distinct from `represents`. A consumer
 * asking "who leads this country?" — the question a quiz asks, or a headline —
 * needs the officeholder with executive power, and neither the form nor the
 * ceremonial/political split answers it alone.
 *
 * Two rules were tried against Mondiale's 194 countries and both failed in
 * opposite directions, which is why this field exists:
 *
 * Keying on `represents` put Austria's Van der Bellen above Chancellor
 * Stocker, Poland's Nawrocki above Tusk and Pakistan's Zardari above Sharif —
 * 13 wrong, because `represents` marks the head of state `political` for every
 * semi-presidential republic whether or not the presidency actually governs.
 *
 * Keying on "a head of government exists" was worse: 39 wrong, including Li
 * Qiang above Xi Jinping, Mishustin above Putin and Lecornu above Macron. In
 * presidential and one-party systems the premier is a subordinate.
 */
export const EXECUTIVE_POWERS = [
  /** A president or monarch governs; any premier serves under them. */
  'head_of_state',
  /** A prime minister governs; the head of state is largely ceremonial. */
  'head_of_government',
  /** No single officeholder — Switzerland's Federal Council, a ruling junta. */
  'collective',
] as const
export type ExecutivePower = (typeof EXECUTIVE_POWERS)[number]
