import { cacheRead, cacheWrite } from '../net/cache'
import type { Standing } from '../types/enums'

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
const PROMPT_VERSION = 'v4'
const API = 'https://api.anthropic.com/v1/messages'

export interface ExtractedBloc {
  name: string
  seats: number
  standing: Standing
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
- The seats must add up to the chamber's declared size. If your rows sum to
  noticeably more, you have taken two levels of a nested list; take the outer
  one. If they sum to noticeably less, you have missed rows.
- A cabinet name in a header ("Government (Støre Cabinet)") is not a party.
- name: the party's display name, without the seat count.
- article: the wikilink target if the row links one, e.g. [[Labour Party
  (Norway)|Labour]] gives article "Labour Party (Norway)".
- alliance: only when the markup nests a party inside a named bloc.
- last_election / next_election: if the markup you are given carries an election
  date, report it as YYYY-MM-DD, or YYYY when only a year is written. Do not
  infer one from anything else. Most fields will not have them; that is fine.

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
