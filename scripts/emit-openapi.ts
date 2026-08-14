import { writeFileSync, mkdirSync } from 'node:fs'
import {
  BLOC_KINDS,
  CHAMBER_ROLES,
  CONFIDENCE,
  CONTESTATION,
  DERIVATIONS,
  GOVERNMENT_FORMS,
  REPRESENTATION,
  SELECTION_METHODS,
  SOURCE_KINDS,
  SPECTRUM_BANDS,
  STANDINGS,
} from '../src/types/enums'

/**
 * The OpenAPI schema, generated from the enums rather than written beside them.
 *
 * A hand-written spec is a second declaration of the same vocabulary and drifts
 * from the first the moment either changes. The enums are `as const` arrays
 * precisely so they can be read at runtime and emitted here — add a standing
 * and the published schema gains it without anyone remembering to.
 */

const enumOf = (values: readonly string[], description: string) => ({
  type: 'string',
  enum: [...values],
  description,
})

const entity = {
  type: 'object',
  required: ['qid'],
  properties: {
    qid: { type: 'string', pattern: '^Q[0-9]+$', description: 'Wikidata entity id.' },
    label: { type: 'string', description: 'English label. May be absent.' },
  },
} as const

const provenance = {
  type: 'object',
  required: ['kind', 'derivation', 'retrieved_at'],
  properties: {
    kind: enumOf(SOURCE_KINDS, 'Which source the value came from.'),
    derivation: enumOf(
      DERIVATIONS,
      'How much interpretation stands between the source and the field. `extracted` means a language model read it from prose or markup and the result was checked by arithmetic.'
    ),
    qid: { type: 'string', pattern: '^Q[0-9]+$' },
    article: { type: 'string' },
    revid: {
      type: 'integer',
      description: 'The exact Wikipedia revision read. The audit trail — a disagreement can be settled by fetching it.',
    },
    retrieved_at: { type: 'string', format: 'date' },
    model: { type: 'string' },
  },
} as const

const imageRef = {
  type: 'object',
  required: ['file', 'url', 'host', 'non_free'],
  description:
    'A pointer to an image, never a re-hosted copy. The licence facts travel with it so each consumer applies its own policy.',
  properties: {
    file: { type: 'string', description: 'Commons/Wikipedia filename, without the File: prefix.' },
    url: { type: 'string', format: 'uri', description: 'Special:FilePath URL. Serves CORS `*`.' },
    host: { type: 'string', enum: ['commons', 'wikipedia'] },
    license: { type: 'string', description: 'As the host states it: "PD", "CC BY-SA 4.0", "Fair use".' },
    non_free: { type: 'boolean', description: 'The host serves it under fair use, not a licence grant.' },
    restrictions: { type: 'string' },
    credit: { type: 'string' },
  },
} as const

const officeHolder = {
  type: 'object',
  required: ['person', 'name', 'party', 'represents', 'provenance'],
  properties: {
    person: entity,
    name: { type: 'string' },
    superseded: {
      type: 'boolean',
      description:
        "The name came from the country's article because the structured record named somebody who has left. The name is current; the dates, portrait and party that would describe them are absent, because those belonged to the previous holder.",
    },
    contested_by: {
      type: 'array',
      description: 'Rival claimants to this office, with the authority they claim it under.',
      items: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, authority: { type: 'string' } },
      },
    },
    office: entity,
    office_local: {
      type: 'string',
      description:
        "The office in its own language — Bundeskanzler, Statsminister, Taoiseach. Frequently the only name anyone in the country says.",
    },
    party: {
      oneOf: [entity, { type: 'null' }],
      description: 'Null when genuinely independent — several heads of state suspend party membership.',
    },
    since: { type: 'string', format: 'date', description: 'Day precision, or absent. Never padded.' },
    born_year: { type: 'integer' },
    portrait: imageRef,
    represents: enumOf(
      REPRESENTATION,
      'Whether this office speaks politically or ceremonially for the state.'
    ),
    provenance,
  },
} as const

const party = {
  type: 'object',
  required: ['entity', 'name', 'kind', 'ideologies', 'groupings', 'colors', 'provenance'],
  properties: {
    entity,
    name: { type: 'string' },
    endonym: { type: 'string' },
    abbreviation: { type: 'string' },
    kind: enumOf(
      BLOC_KINDS,
      'An electoral alliance is not a party. "Which party governs?" has no honest answer when the answer is an alliance of five.'
    ),
    alignment: enumOf(SPECTRUM_BANDS, 'The five-band fold of Wikidata P1387.'),
    alignment_raw: { type: 'string', description: "Wikidata's own label, unfolded." },
    ideologies: { type: 'array', items: entity },
    groupings: {
      type: 'array',
      items: entity,
      description:
        'Transnational families (EPP, Progressive Alliance). Open statements only — an ended membership is not membership.',
    },
    colors: { type: 'array', items: { type: 'string', pattern: '^#[0-9a-f]{6}$' } },
    founded_year: { type: 'integer' },
    dissolved_year: { type: 'integer' },
    logo: imageRef,
    provenance,
  },
} as const

const seating = {
  type: 'object',
  required: ['party', 'name', 'seats', 'share', 'standing'],
  properties: {
    party: {
      oneOf: [{ type: 'string', pattern: '^Q[0-9]+$' }, { type: 'null' }],
      description: 'Reference into the country`s party registry. Null for residual rows, which keep their name.',
    },
    name: { type: 'string' },
    seats: { type: 'integer', minimum: 0 },
    share: { type: 'number', minimum: 0, maximum: 1 },
    standing: enumOf(
      STANDINGS,
      'Confidence-and-supply is why this is not a boolean: a party holding no ministries that supplies the majority is neither government nor opposition.'
    ),
    alliance: { type: 'string' },
    vote_share: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const

const chamber = {
  type: 'object',
  required: [
    'entity',
    'role',
    'name',
    'seats_total',
    'selection',
    'contestation',
    'composition',
    'as_of',
    'retrieved_at',
    'confidence',
    'provenance',
    'source_hash',
  ],
  properties: {
    entity,
    role: enumOf(CHAMBER_ROLES, 'Resolved by walking Wikidata P279 upward, never by exact class.'),
    name: { type: 'string' },
    name_local: { type: 'string' },
    seats_total: { type: 'integer', minimum: 0 },
    selection: { type: 'array', items: enumOf(SELECTION_METHODS, 'How members arrive.') },
    contestation: enumOf(
      CONTESTATION,
      'How real the contest is. Orthogonal to structure: a chamber can be bicameral, directly elected AND uncontested.'
    ),
    seats_contested: { type: 'integer' },
    composition: { type: 'array', items: seating },
    last_election: { type: 'string', format: 'date' },
    next_election: { type: 'string', format: 'date' },
    term_years: {
      type: 'number',
      description:
        "The constitutional term. What makes a missing next_election usable: a chamber elected five years ago under a four-year term is overdue whether or not a date was recorded.",
    },
    mandate: {
      type: 'object',
      description:
        'Where the chamber stands in its electoral cycle — the early warning that a composition may be about to go out of date. Entirely derived; absent when nothing is known.',
      required: ['state', 'inferred'],
      properties: {
        expected_end: {
          type: 'string',
          format: 'date',
          description:
            'When the mandate is expected to end. An ABSOLUTE date on purpose — a "days remaining" count would be wrong the morning after it was written, since the file is rebuilt weekly. Compute the difference against your own clock.',
        },
        inferred: {
          type: 'boolean',
          description: 'True when expected_end came from term_years rather than a scheduled date.',
        },
        state: {
          type: 'string',
          enum: ['current', 'due_soon', 'overdue', 'unknown'],
          description:
            '`overdue` is a signal to re-check the source, not an accusation — a term can be legally extended.',
        },
      },
    },
    as_of: {
      type: 'string',
      format: 'date',
      description:
        'The vintage of the composition — the election it describes, NOT the day the pipeline ran. Falls back to the retrieval date only when no election date is known.',
    },
    retrieved_at: {
      type: 'string',
      format: 'date',
      description: 'When the source was last read. Distinct from as_of.',
    },
    superseded_by_election: {
      type: 'object',
      description:
        'An election has been held that this composition does not describe. Found by checking whether the election article exists — it says the seats are out of date and names what supersedes them, not what the result was.',
      required: ['article', 'year'],
      properties: { article: { type: 'string' }, year: { type: 'integer' } },
    },
    confidence: enumOf(CONFIDENCE, 'In the data, not a log: a consumer must tell a verified row from a guessed one.'),
    provenance,
    source_hash: {
      type: 'string',
      description:
        'Hash of the source field the composition was read from — the change-detection key, and what makes a re-extraction happen only on a real change.',
    },
  },
} as const

const government = {
  type: 'object',
  required: ['governing', 'backing', 'seats', 'minority', 'confidence', 'provenance'],
  properties: {
    governing: { type: 'array', items: { type: 'string', pattern: '^Q[0-9]+$' } },
    backing: { type: 'array', items: { type: 'string', pattern: '^Q[0-9]+$' } },
    cabinet: entity,
    seats: { type: 'integer' },
    seats_with_backing: { type: 'integer' },
    minority: {
      type: 'boolean',
      description:
        'Computed from seats, never from "has backers" — Denmark and Spain govern in a minority with no supply deal at all.',
    },
    description: { type: 'string' },
    formed: { type: 'string', format: 'date' },
    confidence: enumOf(CONFIDENCE, ''),
    provenance,
  },
} as const

const polity = {
  type: 'object',
  required: [
    'iso',
    'entity',
    'name',
    'form',
    'form_raw',
    'head_of_state',
    'head_of_government',
    'parties',
    'chambers',
    'government',
    'sources',
    'updated_at',
  ],
  properties: {
    iso: { type: 'string', pattern: '^[A-Z]{2}$' },
    entity,
    name: { type: 'string' },
    form: enumOf(GOVERNMENT_FORMS, 'Folded from Wikidata P122 at preferred rank.'),
    form_raw: { type: 'array', items: { type: 'string' } },
    head_of_state: officeHolder,
    head_of_government: {
      oneOf: [officeHolder, { type: 'null' }],
      description:
        'Null when the SAME PERSON holds both offices — explicitly, so "one person does both jobs" is distinguishable from "we only found one".',
    },
    parties: { type: 'object', additionalProperties: party },
    chambers: {
      type: 'array',
      items: chamber,
      description:
        'One entry for unicameral, two for bicameral. The shape never changes, so a consumer writes one code path. Pick by role, never by index.',
    },
    government,
    sources: { type: 'array', items: provenance },
    updated_at: { type: 'string', format: 'date' },
  },
} as const

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'polity',
    version: '1.0.0',
    description:
      "Every country's government, parliament and parties — as structured, typed, verifiable data. Generated from Wikidata and Wikipedia, rebuilt on a schedule, published as static JSON.",
    license: { name: 'ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/' },
  },
  paths: {
    '/polity.json': {
      get: {
        summary: 'The whole dataset.',
        responses: {
          '200': {
            description: 'Every country, keyed by ISO 3166-1 alpha-2.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PolityDataset' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Entity: entity,
      Provenance: provenance,
      ImageRef: imageRef,
      OfficeHolder: officeHolder,
      Party: party,
      Seating: seating,
      Chamber: chamber,
      Government: government,
      Polity: polity,
      PolityDataset: {
        type: 'object',
        required: ['schema_version', 'generated_at', 'countries', 'omissions'],
        properties: {
          schema_version: { type: 'string' },
          generated_at: { type: 'string', format: 'date-time' },
          countries: { type: 'object', additionalProperties: polity },
          omissions: {
            type: 'array',
            description: 'What did not make it in, and why — published, not logged.',
            items: {
              type: 'object',
              required: ['iso', 'reason'],
              properties: { iso: { type: 'string' }, reason: { type: 'string' } },
            },
          },
        },
      },
    },
  },
}

mkdirSync('schema', { recursive: true })
writeFileSync('schema/openapi.json', `${JSON.stringify(spec, null, 2)}\n`)
console.log(
  `wrote schema/openapi.json — ${Object.keys(spec.components.schemas).length} schemas, ` +
    `${[STANDINGS, CHAMBER_ROLES, CONTESTATION, GOVERNMENT_FORMS, SPECTRUM_BANDS, BLOC_KINDS, CONFIDENCE, DERIVATIONS, SOURCE_KINDS, SELECTION_METHODS, REPRESENTATION].reduce((total, list) => total + list.length, 0)} enum values`
)
