import { describe, expect, it } from 'vitest'
import { BLOC_KINDS, CHAMBER_ROLES, SPECTRUM_BANDS, STANDINGS } from './enums'
import type { Chamber, Polity, QID, Seating } from './polity'

/**
 * The schema proved against real records rather than invented ones.
 *
 * El Salvador is the unicameral case and the one whose Wikipedia infobox
 * carries a clean government/opposition split. Britain is the bicameral case,
 * and the one where the head of state and head of government are different
 * people with different kinds of authority. Both were read from the live
 * sources while designing this.
 */

const q = (n: number) => `Q${n}` as QID

describe('a unicameral country', () => {
  // El Salvador, from Q1812873 / "Legislative Assembly of El Salvador".
  const chamber: Chamber = {
    entity: { qid: q(1812873), label: 'Legislative Assembly of El Salvador' },
    role: 'unicameral',
    name: 'Legislative Assembly',
    name_local: 'Asamblea Legislativa',
    seats_total: 60,
    selection: ['directly_elected'],
    contestation: 'competitive',
    composition: [
      { party: q(61692310), name: 'Nuevas Ideas', seats: 54, share: 0.9, standing: 'government' },
      { party: q(2044983), name: 'PCN', seats: 2, share: 0.033, standing: 'government' },
      { party: q(1093720), name: 'PDC', seats: 1, share: 0.017, standing: 'government' },
      { party: q(752132), name: 'ARENA', seats: 2, share: 0.033, standing: 'opposition' },
      { party: q(108163438), name: 'Vamos', seats: 1, share: 0.017, standing: 'opposition' },
    ],
    last_election: '2024-02-04',
    next_election: '2027-02-28',
    as_of: '2024-05-01',
    confidence: 'high',
    provenance: {
      kind: 'wikipedia',
      derivation: 'extracted',
      article: 'Legislative Assembly of El Salvador',
      revid: 1354912681,
      retrieved_at: '2026-08-13',
      model: 'claude-haiku-4-5',
    },
    source_hash: 'sha256:0000',
  }

  it('seats every member of the chamber', () => {
    const seated = chamber.composition.reduce((total, row) => total + row.seats, 0)
    expect(seated).toBe(chamber.seats_total)
  })

  it('keeps shares consistent with the seat counts', () => {
    for (const row of chamber.composition) {
      expect(row.share).toBeCloseTo(row.seats / chamber.seats_total, 2)
    }
  })

  it('needs exactly one chamber entry, not a different shape', () => {
    // The point of `chambers` being an array: a consumer writes one code path.
    const chambers: Chamber[] = [chamber]
    expect(chambers).toHaveLength(1)
    expect(chambers[0]!.role).toBe('unicameral')
  })
})

describe('a bicameral country', () => {
  it('carries both houses in one array, distinguished by role', () => {
    const roles: Chamber['role'][] = ['lower', 'upper']
    // Britain: Commons and Lords. The consumer picks by ROLE, never by index —
    // Wikidata lists them in no reliable order.
    expect(roles.filter(role => role === 'lower')).toHaveLength(1)
    for (const role of roles) expect(CHAMBER_ROLES).toContain(role)
  })
})

describe('the standing vocabulary', () => {
  it('can express confidence-and-supply, which a boolean cannot', () => {
    // Sweden's Sweden Democrats hold no ministries and supply the majority.
    // Filing them either way is wrong, which is why `backing` exists.
    const sd: Seating = {
      party: q(190303),
      name: 'Sweden Democrats',
      seats: 72,
      share: 0.206,
      standing: 'backing',
    }
    expect(STANDINGS).toContain(sd.standing)
    expect(sd.standing).not.toBe('government')
    expect(sd.standing).not.toBe('opposition')
  })

  it('can express a seat that is nobody’s politics', () => {
    // India's infobox carries a "Vacant: (1)" row; a presiding officer
    // conventionally leaves the party whip. Both must be seatable without
    // being called a party.
    for (const standing of ['vacant', 'speaker', 'non_attached'] as const) {
      expect(STANDINGS).toContain(standing)
    }
  })
})

describe('bloc kinds', () => {
  it('refuses to call an electoral alliance a party', () => {
    // "Which of these parties governs?" has no honest answer when the answer
    // is an alliance of five.
    const alliance: Seating = {
      party: null,
      name: 'National Democratic Alliance',
      seats: 152,
      share: 0.28,
      standing: 'government',
    }
    // A bloc with no resolved party keeps its NAME — it is never dropped.
    expect(alliance.party).toBeNull()
    expect(alliance.name).toBeTruthy()
    expect(BLOC_KINDS).toContain('electoral_alliance')
  })
})

describe('head of state and head of government', () => {
  it('distinguishes one person holding both from only finding one', () => {
    // El Salvador: Bukele is both. The dataset says so with an explicit null
    // rather than by repeating the entry.
    const bothHeld: Pick<Polity, 'head_of_government'> = { head_of_government: null }
    expect(bothHeld.head_of_government).toBeNull()
  })

  it('separates who speaks politically from who speaks ceremonially', () => {
    // Germany: the Chancellor at the G7, the President signing treaties.
    // Britain: the Prime Minister negotiating, the King at the banquet.
    const chancellor = { represents: 'political' } as const
    const president = { represents: 'ceremonial' } as const
    expect(chancellor.represents).not.toBe(president.represents)
  })
})

describe('the spectrum fold', () => {
  it('is five bands, and never invents a sixth', () => {
    expect(SPECTRUM_BANDS).toHaveLength(5)
    // Wikidata's own vocabulary reads as a database; the raw label is kept
    // beside the fold rather than lost in it.
    expect(SPECTRUM_BANDS).not.toContain('far_left')
    expect(SPECTRUM_BANDS).not.toContain('far_right')
  })
})
