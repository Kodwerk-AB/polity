import { cacheRead, cacheWrite } from '../net/cache'
import { IDEOLOGY_FAMILIES, type IdeologyFamily, type Standing } from '../types/enums'

/**
 * The extraction step, and the only place a language model touches the data.
 *
 * The model is asked to do exactly one thing it is good at: read markup a human
 * wrote for other humans and report its structure. It is never asked to recall
 * anything. Every number it returns is present in the text it was handed, and
 * the validator downstream checks the arithmetic against the chamber's declared
 * size — so a hallucinated seat count fails a sum rather than shipping.
 *
 * Results are cached on the SOURCE HASH, so re-running the pipeline costs
 * nothing and a country is re-extracted only when its composition field
 * actually changed.
 */

const MODEL = 'claude-haiku-4-5-20251001'
/** Bumped whenever SYSTEM changes, so a prompt fix invalidates old answers
 *  rather than serving a cached reading of a rule that no longer applies. */
const PROMPT_VERSION = 'v11'
const API = 'https://api.anthropic.com/v1/messages'

export interface ExtractedBloc {
  name: string
  seats: number
  standing: Standing
  /**
   * What the row IS, judged by the model that can read it.
   *
   * This was a regex over names, and a regex cannot tell "Independents" (a
   * tally of unaffiliated members) from "Independence" (a Latvian party), or
   * "New Flemish Alliance" (a party) from "Advanced Indonesia Coalition" (an
   * alliance). 142 entries are named like blocs and are ordinary parties. The
   * model has the row, its neighbours and the country in front of it, which is
   * exactly the context the judgement needs.
   */
  kind?: 'party' | 'electoral_alliance' | 'parliamentary_group' | 'independents' | 'residual'
  /** The wikilink target, when the row links one — the Q-id resolution key. */
  article?: string
  /** The bloc this row stood in, when the markup nests them. */
  alliance?: string
}

export interface Extraction {
  blocs: ExtractedBloc[]
  /** The last election, ISO date or year, when the markup carries one. */
  last_election?: string
  /** The next scheduled election, same. */
  next_election?: string
  /** How the source phrases the government — "minority coalition government". */
  description?: string
  /** The model's own reading of whether the field was legible. */
  legible: boolean
}

const SYSTEM = `You extract parliamentary composition from Wikipedia infobox markup.

You will be given the raw value of a legislature infobox's political_groups
field. Report ONLY what the markup says. Never add a party you were not given,
never adjust a number, never fill a gap from memory.

legible:false means the markup contains NO parties with seat counts at all —
an empty field, or one holding only a diagram or a note. If you can see even
one party with a number beside it, that is legible:true and you report what you
can. Partial and imperfect beats empty: a chamber you refuse is a country
missing from the dataset, where a chamber whose seats do not quite sum is
flagged and still useful. Never return legible:false because the structure is
awkward, nested, ambiguous, or hard to split into government and opposition.

Rules:
- Every row with a seat count becomes a bloc. The count is the number in
  parentheses, or in a Composition bar template's parameters.
- standing: read the BOLD HEADERS. "Government"/"Governing coalition" means
  government. "Opposition" means opposition. "Confidence and supply",
  "Supported by", "Supply" means backing. A speaker's own row is speaker.
  "Vacant" is vacant. "Independents"/"Non-attached"/"Crossbench" is
  non_attached. When no header applies to a row, use opposition ONLY if other
  rows are clearly marked government; otherwise use non_attached.
- A header row that is itself a total ("Government (57)") is NOT a bloc. Skip
  it. Only the individual parties beneath it are blocs.
- COUNT EACH SEAT ONCE. Where the markup nests parties inside parliamentary
  groups (France lists "Together for the Republic group (92)" and then
  Renaissance, Territories of Progress and others beneath it), report ONE level
  only — reporting both double-counts every seat. Prefer the level whose totals
  add up to the chamber's declared size; that is usually the individual parties
  where they are listed under a standing header, and the groups where the groups
  themselves carry the seats.
  A standing header like "Government (108)" is NOT one of those levels — it is
  a header, its total is the sum of the rows beneath it, and those rows are the
  blocs. Report them with standing:government, not the header.
  BUT a header with NOTHING beneath it is all the chamber has, and you should
  report it as a bloc. Tuvalu's whole composition is "Government (10)" and
  "Opposition (6)"; Qatar's is "Appointed by Emir (45)". Those are real seat
  counts and refusing them loses the chamber entirely. Name the bloc as the
  markup names it and give it the matching standing — "Appointed by Emir" is
  a bloc named exactly that, with standing non_attached.
- CHECK YOUR TOTAL BEFORE ANSWERING. Add up the seats you are about to report
  and compare with the declared size you were given.
  * Sum much LARGER: you have counted a nesting twice. Brazil lists a coalition
    ("Brazil of Hope", 81) and then the parties inside it (PT 64, PCdoB 11,
    PV 6). Report the coalition OR its members, never both. An {{efn|...}}
    footnote often restates a party that is already listed — those restatements
    are notes, not extra blocs, and must not be counted.
  * Sum much SMALLER: you have missed rows. Read to the very end of the markup;
    the opposition is usually listed after the government and is easy to stop
    short of.
  Getting within a few seats of the declared size is the strongest signal that
  you read the structure correctly.
- A cabinet name in a header ("Government (Støre Cabinet)") is not a party.
- name: the party's display name, without the seat count.
- kind: what the row is.
  * party — a single political party, however it is named. "New Flemish
    Alliance", "National Liberation Front", "Democratic Front" and "Centre
    Alliance" are all parties despite the words in their names.
  * electoral_alliance — parties that contested the election on one list, or a
    named bloc holding seats its member parties are not separately listed for.
  * parliamentary_group — a group formed inside the chamber after the election.
  * independents — a tally of members elected as no party's candidate:
    "Independents", "Non-attached", "Crossbench". Note that a PARTY may be
    called "Independence" or "Independent Greens" and is not this.
  * residual — the chamber's own bookkeeping: "Vacant", "Others", "Speaker",
    "Appointed by Emir", a seat category rather than an organisation.
- article: the wikilink target if the row links one, e.g. [[Labour Party
  (Norway)|Labour]] gives article "Labour Party (Norway)".
- alliance: only when the markup nests a party inside a named bloc.
- last_election / next_election: report ONLY from a field literally named
  last_election or next_election. Those are the chamber's own elections. Any
  other date in the markup belongs to a person — when a speaker or a party
  leader took office — and must never be reported as the chamber's election.
  Format as YYYY-MM-DD, or YYYY when only a year is written. Most fields carry
  neither; that is fine, report nothing.

Return JSON only, matching the schema exactly.`

const TOOL = {
  name: 'report_composition',
  description: 'Report the parliamentary composition found in the markup.',
  input_schema: {
    type: 'object',
    properties: {
      legible: {
        type: 'boolean',
        description: 'False when the markup carries no usable composition.',
      },
      description: {
        type: 'string',
        description: 'How the source phrases the government, if it does.',
      },
      last_election: { type: 'string', description: 'YYYY-MM-DD or YYYY, if present.' },
      next_election: { type: 'string', description: 'YYYY-MM-DD or YYYY, if present.' },
      blocs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            seats: { type: 'integer', minimum: 0 },
            standing: {
              type: 'string',
              enum: ['government', 'backing', 'opposition', 'speaker', 'non_attached', 'vacant'],
            },
            kind: {
              type: 'string',
              enum: [
                'party',
                'electoral_alliance',
                'parliamentary_group',
                'independents',
                'residual',
              ],
            },
            article: { type: 'string' },
            alliance: { type: 'string' },
          },
          required: ['name', 'seats', 'standing'],
          additionalProperties: false,
        },
      },
    },
    required: ['legible', 'blocs'],
    additionalProperties: false,
  },
} as const

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let calls = 0
export const extractionCount = () => calls

/**
 * Extract one chamber's composition.
 *
 * Cached on `sourceHash`: the same markup never costs a second call, which is
 * what makes a full rebuild ~$0.24 and a weekly run effectively free.
 */
export const extractComposition = async (
  sourceHash: string,
  markup: string,
  context: { chamber: string; country: string; seats?: number }
): Promise<Extraction | undefined> => {
  const cacheKey = `extract:${MODEL}:${PROMPT_VERSION}:${sourceHash}`
  const cached = cacheRead<Extraction>(cacheKey)
  if (cached !== undefined) return cached

  const apiKey = process.env.CLAUDE_KEY
  if (!apiKey) throw new Error('CLAUDE_KEY is not set')

  const prompt =
    `Country: ${context.country}\nChamber: ${context.chamber}` +
    (context.seats ? `\nDeclared size: ${context.seats} seats` : '') +
    `\n\nMarkup:\n${markup.slice(0, 12000)}`

  for (let attempt = 1; attempt <= 4; attempt++) {
    calls++
    const response = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(120_000),
    }).catch(() => undefined)

    if (response?.ok) {
      const body = (await response.json().catch(() => undefined)) as
        | { content?: { type?: string; input?: unknown }[] }
        | undefined
      const block = body?.content?.find(part => part.type === 'tool_use')
      const parsed = block?.input as Extraction | undefined
      if (parsed && Array.isArray(parsed.blocs)) {
        // Defensive: the schema is enforced at the API, but a malformed row
        // must not reach the dataset regardless.
        const blocs = parsed.blocs.filter(
          bloc =>
            typeof bloc?.name === 'string' &&
            bloc.name.trim().length > 0 &&
            Number.isFinite(bloc.seats) &&
            bloc.seats >= 0
        )
        const result: Extraction = { blocs, legible: parsed.legible !== false }
        if (parsed.description) result.description = parsed.description
        if (parsed.last_election) result.last_election = parsed.last_election
        if (parsed.next_election) result.next_election = parsed.next_election
        cacheWrite(cacheKey, result)
        return result
      }
    }
    if (response?.status === 400 || response?.status === 401) {
      console.warn(`  model refused (${response.status}) for ${context.country}`)
      return undefined
    }
    await sleep(2000 * attempt)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Leaders
// ---------------------------------------------------------------------------

export interface ExtractedClaimant {
  office: 'head_of_state' | 'head_of_government'
  name: string
  authority?: string
}

export interface ExtractedLeaders {
  head_of_state?: string
  head_of_government?: string
  /** True when the same person holds both offices. */
  same_person: boolean
  /** The source itself says the office is contested or the holder disputed. */
  disputed: boolean
  /** Who else claims an office, and under what rival authority. */
  claimants?: ExtractedClaimant[]
  /** The source names no holder because rivals claim it — Libya's premiership. */
  vacant_contested?: boolean
}

const LEADER_SYSTEM = `You read the leadership fields of a country's Wikipedia infobox.

Report ONLY names that appear in the text given. Never supply a name from
memory, never guess a successor, never complete a partial name.

Rules:
- head_of_state: the person under the title that heads the STATE — President,
  Monarch, King, Queen, Emir, Sultan, Supreme Leader, Chairman. For a country
  under a junta or transitional council, that is the council's chairman or
  transitional president.
- head_of_government: the person under Prime Minister, Chancellor, Taoiseach,
  Premier, President of the Government. NOT a vice president or deputy.
- If the same person holds both, report that name for BOTH and same_person true.
- If the country has no separate head of government (a presidential system),
  report head_of_government as the head of state and same_person true.
- The fields carry editorial debris: stray quote= parameters, footnote markers,
  parenthetical notes like (interim) or (acting). Report the NAME only, without
  the note — but set disputed true when the text says the office is contested,
  disputed, vacant, or claimed by more than one person.
- A title with no name beside it means nobody is recorded. Omit that office
  rather than borrowing a name from another line.
- Report a PERSON'S NAME, never a description of one. Canada's field holds
  "{{Current Canadian monarch}}", a template that renders to a name we cannot
  see; "Current Canadian monarch", "the reigning monarch", "President of X" and
  "vacant" are all descriptions, not names. Omit the office when that is all
  the text gives you — a missing leader is recoverable, a title masquerading as
  a person is not. If the title is there and the
  name is missing BECAUSE rivals claim it, set vacant_contested true.
- claimants: when a name carries a note that another person disputes it, record
  that person. Sudan writes "Disputed by Abdelaziz al-Hilu of the Government of
  Peace and Unity" — report name "Abdelaziz al-Hilu" and authority "Government
  of Peace and Unity". Report the office they contest. Set disputed true
  whenever there is at least one claimant, or the source calls an office
  contested, disputed or claimed.
- Do NOT infer a dispute from your own knowledge of a country's politics. Only
  report what the text in front of you says. A civil war the infobox does not
  mention is not yours to add.

Return JSON only.`

const LEADER_TOOL = {
  name: 'report_leaders',
  description: "Report the leaders named in a country's infobox.",
  input_schema: {
    type: 'object',
    properties: {
      head_of_state: { type: 'string' },
      head_of_government: { type: 'string' },
      same_person: { type: 'boolean' },
      disputed: { type: 'boolean' },
      vacant_contested: { type: 'boolean' },
      claimants: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            office: { type: 'string', enum: ['head_of_state', 'head_of_government'] },
            name: { type: 'string' },
            authority: { type: 'string' },
          },
          required: ['office', 'name'],
          additionalProperties: false,
        },
      },
    },
    required: ['same_person', 'disputed'],
    additionalProperties: false,
  },
} as const

/**
 * Read a country's current leaders from its article infobox.
 *
 * Cached on the source hash, like the composition extractor — a country whose
 * leadership lines have not changed costs nothing on a rebuild.
 */
export const extractLeaders = async (
  sourceHash: string,
  markup: string,
  country: string
): Promise<ExtractedLeaders | undefined> => {
  const cacheKey = `leaders:${MODEL}:${PROMPT_VERSION}:${sourceHash}`
  const cached = cacheRead<ExtractedLeaders>(cacheKey)
  if (cached !== undefined) return cached

  const apiKey = process.env.CLAUDE_KEY
  if (!apiKey) throw new Error('CLAUDE_KEY is not set')

  for (let attempt = 1; attempt <= 4; attempt++) {
    calls++
    const response = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: LEADER_SYSTEM,
        tools: [LEADER_TOOL],
        tool_choice: { type: 'tool', name: LEADER_TOOL.name },
        messages: [{ role: 'user', content: `Country: ${country}\n\n${markup.slice(0, 4000)}` }],
      }),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => undefined)

    if (response?.ok) {
      const body = (await response.json().catch(() => undefined)) as
        | { content?: { type?: string; input?: unknown }[] }
        | undefined
      const parsed = body?.content?.find(part => part.type === 'tool_use')?.input as
        | ExtractedLeaders
        | undefined
      if (parsed) {
        cacheWrite(cacheKey, parsed)
        return parsed
      }
    }
    if (response?.status === 400 || response?.status === 401) return undefined
    await sleep(1500 * attempt)
  }
  return undefined
}

/**
 * Which broad family each ideology belongs to.
 *
 * Wikidata names 409 distinct ideologies across these parties, 222 of them
 * appearing exactly once. That tail is the useful part — "Kemalism", "Basque
 * nationalism", "Pancasila", "socialism with Chinese characteristics" — so it
 * is kept verbatim in `ideologies` and classified ALONGSIDE, never folded away.
 *
 * The model does the classification because the alternative is a hand-written
 * table of 409 Q-ids, which is exactly the kind of thing that gets written from
 * memory and quietly filled with identifiers that do not exist. Here every
 * Q-id comes from the data and the model only sorts labels it is shown.
 *
 * Cached per ideology, so a rebuild classifies only what is new.
 */
const FAMILY_SYSTEM = `You sort political ideologies into broad families.

Return one family per ideology, using ONLY these values:

- social_democratic — social democracy, democratic socialism, labourism, Third Way
- socialist — communism, Marxism, Trotskyism, anti-capitalism, revolutionary socialism
- liberal — market and social liberalism, libertarianism, progressivism, secularism, civil rights
- conservative — conservatism in all variants, monarchism, traditionalism
- religious — confessional politics of ANY faith: Christian democracy, Islamism, religious Zionism
- green — green politics, environmentalism, eco-socialism, sustainability
- nationalist — nationalism, regionalism, separatism, unionism, irredentism, ethnic and
  linguistic nationalism. A claim about who the nation IS or where its borders belong.
- internationalist — a stance toward a supranational bloc or neighbour rather than a domestic
  tradition: pro-Europeanism, euroscepticism, Atlanticism, pan-Africanism, sovereigntism
- populist — populism of either wing, anti-establishment and anti-corruption politics
- agrarian — agrarian, rural and peasant-interest politics
- authoritarian — authoritarianism, militarism, fascism, ultranationalism, one-party doctrine
- reformist — institutional reform: federalism, decentralisation, direct democracy,
  constitutionalism, pacifism, anti-fascism
- other — real and named, but outside every family above

Rules:
- A family is BROADER than a left-right placement. Nationalism spans both wings; put it in
  nationalist rather than choosing a side.
- Do NOT read a bloc stance as nationalism. Pro-Europeanism and euroscepticism are
  internationalist, not nationalist — most of the European centre holds one or the other.
- Judge the ideology itself, not parties that happen to hold it.
- Prefer the most specific family that fits. Use other sparingly and only when nothing fits.`

const FAMILY_TOOL = {
  name: 'report_families',
  description: 'Report the family of each ideology given.',
  input_schema: {
    type: 'object' as const,
    properties: {
      families: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            qid: { type: 'string' },
            family: {
              type: 'string',
              enum: [...IDEOLOGY_FAMILIES],
            },
          },
          required: ['qid', 'family'],
        },
      },
    },
    required: ['families'],
  },
}

/**
 * Classify ideologies in batches, returning a Q-id → family map.
 *
 * Only uncached ideologies are sent, so the steady-state cost is zero.
 */
export const classifyIdeologies = async (
  ideologies: { qid: string; label: string }[]
): Promise<Record<string, IdeologyFamily>> => {
  const known: Record<string, IdeologyFamily> = {}
  const pending: { qid: string; label: string }[] = []
  for (const ideology of ideologies) {
    const cached = cacheRead<IdeologyFamily>(`family:${PROMPT_VERSION}:${ideology.qid}`)
    if (cached) known[ideology.qid] = cached
    else pending.push(ideology)
  }
  if (!pending.length) return known

  const apiKey = process.env.CLAUDE_KEY
  if (!apiKey) throw new Error('CLAUDE_KEY is not set')

  // 60 at a time keeps each response comfortably inside the token budget.
  for (let index = 0; index < pending.length; index += 60) {
    const batch = pending.slice(index, index + 60)
    const listing = batch.map(item => `${item.qid} ${item.label}`).join('\n')

    for (let attempt = 1; attempt <= 4; attempt++) {
      calls++
      const response = await fetch(API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          system: FAMILY_SYSTEM,
          tools: [FAMILY_TOOL],
          tool_choice: { type: 'tool', name: FAMILY_TOOL.name },
          messages: [{ role: 'user', content: listing }],
        }),
        signal: AbortSignal.timeout(90_000),
      }).catch(() => undefined)

      if (response?.ok) {
        const body = (await response.json().catch(() => undefined)) as
          | { content?: { type?: string; input?: unknown }[] }
          | undefined
        const parsed = body?.content?.find(part => part.type === 'tool_use')?.input as
          | { families?: { qid?: string; family?: string }[] }
          | undefined
        for (const row of parsed?.families ?? []) {
          if (!row.qid || !row.family) continue
          if (!(IDEOLOGY_FAMILIES as readonly string[]).includes(row.family)) continue
          const family = row.family as IdeologyFamily
          known[row.qid] = family
          cacheWrite(`family:${PROMPT_VERSION}:${row.qid}`, family)
        }
        break
      }
      if (response?.status === 400 || response?.status === 401) break
      await sleep(1500 * attempt)
    }
  }
  return known
}
