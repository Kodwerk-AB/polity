import { describe, expect, it } from 'vitest'
import { landslideOr, selectionOf, withoutAllianceHeaders } from './build'
import { personName, resolveStatement } from './net/wiki'
import { executivePowerOf, trustedHolder } from './resolve/leaders'
import { FREE_ELECTION_SCORE } from './resolve/democracy'
import { familiesOf } from './resolve/ideology'
import type { QID } from './types/polity'

/**
 * Both rules exist because a chamber's SHAPE does not reveal how it was filled.
 * These are the cases that motivated them, kept as tests because each one
 * regressed silently before the rule existed.
 */

describe('selectionOf', () => {
  // Real `voting_system` values. Antigua's Senate and Australia's are
  // structurally identical — a few rows, no visible contest — and only this
  // field separates them.
  it('reads an appointed chamber from its voting system', () => {
    expect(selectionOf('upper', 'Appointment by the Governor-General of Antigua and Barbuda')).toEqual([
      'appointed',
    ])
    expect(selectionOf('upper', 'Appointed by the President of Barbados')).toEqual(['appointed'])
    expect(selectionOf('upper', 'Appointment by the Monarchy of Canada')).toEqual(['appointed'])
  })

  it('reads a directly elected upper house, against the role default', () => {
    expect(selectionOf('upper', 'Proportional representation (single transferable vote)')).toEqual([
      'directly_elected',
    ])
  })

  it('reports every method a mixed chamber uses', () => {
    // Bhutan's National Council: 20 elected, 5 appointed by the King.
    expect(selectionOf('upper', 'Direct election, with 5 appointed members')).toEqual([
      'directly_elected',
      'appointed',
    ])
  })

  it('ignores a value that is not really there', () => {
    // Oman's article leaves the field empty, so the regex captured the NEXT
    // field's name — "| voting_system2 =" — which matched on the word "voting"
    // and reported an elected chamber as appointed. `chamberSource` now returns
    // undefined for an empty field, which must land on the role default.
    expect(selectionOf('unicameral', undefined)).toEqual(['directly_elected'])
  })

  it('falls back to the role when the article states nothing', () => {
    expect(selectionOf('upper', undefined)).toEqual(['indirectly_elected'])
    expect(selectionOf('lower', undefined)).toEqual(['directly_elected'])
    expect(selectionOf('lower', '')).toEqual(['directly_elected'])
  })
})

describe('landslideOr', () => {
  const score = (value: number) => ({ score: value, year: 2025 })

  it('clears a landslide in a free election', () => {
    // Barbados took 30 of 30 seats in 2022; nobody disputes the election.
    expect(landslideOr('uncontested', score(0.797))).toBe('competitive')
    expect(landslideOr('restricted', score(0.738))).toBe('competitive')
  })

  it('leaves a genuine autocracy condemned', () => {
    expect(landslideOr('uncontested', score(0.148))).toBe('uncontested')
    expect(landslideOr('uncontested', score(0.163))).toBe('uncontested')
    expect(landslideOr('restricted', score(0.171))).toBe('restricted')
  })

  it('leaves our own reading standing in the contested middle', () => {
    // The bands overlap here — Senegal (0.633) scores above Kenya (0.563) —
    // so a middling score is treated as no evidence rather than evidence for.
    expect(landslideOr('restricted', score(0.633))).toBe('restricted')
    expect(landslideOr('uncontested', score(0.563))).toBe('uncontested')
    expect(landslideOr('restricted', score(FREE_ELECTION_SCORE - 0.001))).toBe('restricted')
  })

  it('treats absent coverage as no evidence, never as a low score', () => {
    // V-Dem omits 17 UN members, nearly all small states.
    expect(landslideOr('uncontested', undefined)).toBe('uncontested')
    expect(landslideOr('restricted', undefined)).toBe('restricted')
  })
})

describe('withoutAllianceHeaders', () => {
  const bloc = (name: string, seats: number, alliance?: string) => ({
    name,
    seats,
    standing: 'government' as const,
    ...(alliance ? { alliance } : {}),
  })

  it('drops a coalition header whose members are listed beneath it', () => {
    // Kenya: the alliance total and every member party, so 349 seats sum to 686.
    const kept = withoutAllianceHeaders([
      bloc('Kenya Kwanza', 179),
      bloc('United Democratic Alliance', 143, 'Kenya Kwanza'),
      bloc('Amani National Congress', 7, 'Kenya Kwanza'),
      bloc('Azimio la Umoja', 158),
      bloc('Orange Democratic Movement', 89, 'Azimio la Umoja'),
      bloc('Independents', 12),
    ])
    expect(kept.map(row => row.name)).toEqual([
      'United Democratic Alliance',
      'Amani National Congress',
      'Orange Democratic Movement',
      'Independents',
    ])
  })

  it('keeps a large party that no row claims as its parent', () => {
    // The regression this rule replaced: an arithmetic version treated any row
    // whose seats equalled the sum of those beneath it as a header, and deleted
    // the CDU from the Bundestag and the Conservatives from the Commons.
    const bundestag = [
      bloc('CDU/CSU', 208),
      bloc('AfD', 152),
      bloc('SPD', 120),
      bloc('The Greens', 85),
      bloc('The Left', 64),
    ]
    expect(withoutAllianceHeaders(bundestag)).toEqual(bundestag)
  })

  it('leaves a chamber with no nesting untouched', () => {
    const commons = [bloc('Labour Party', 405), bloc('Conservative Party', 121)]
    expect(withoutAllianceHeaders(commons)).toEqual(commons)
  })

  it('keeps an alliance whose members are NOT listed separately', () => {
    // Nothing names it as a parent, so its seats are the only record of them.
    const rows = [bloc('National Coalition', 40), bloc('Opposition Party', 20)]
    expect(withoutAllianceHeaders(rows)).toEqual(rows)
  })
})

describe('familiesOf', () => {
  const map = {
    Q121254: 'social_democratic' as const,
    Q1661415: 'green' as const,
    Q3781399: 'internationalist' as const,
  }

  it('reports every family a party spans', () => {
    // Collapsing to one would be a judgement the source does not support.
    expect(
      familiesOf([{ qid: 'Q121254' as QID }, { qid: 'Q1661415' as QID }], map)
    ).toEqual(['social_democratic', 'green'])
  })

  it('deduplicates and orders by the canonical list', () => {
    expect(
      familiesOf(
        [{ qid: 'Q1661415' as QID }, { qid: 'Q121254' as QID }, { qid: 'Q121254' as QID }],
        map
      )
    ).toEqual(['social_democratic', 'green'])
  })

  it('does not read a bloc stance as nationalism', () => {
    // Pro-Europeanism filed under `nationalist` made the Liberal Democrats and
    // the Green Party of England and Wales read as nationalist parties.
    expect(familiesOf([{ qid: 'Q3781399' as QID }], map)).toEqual(['internationalist'])
  })

  it('falls to `other` only when ideologies exist but none place', () => {
    expect(familiesOf([{ qid: 'Q999999999' as QID }], map)).toEqual(['other'])
    // No ideologies at all is an empty array — never `other`, which would
    // assert something about a party we know nothing about.
    expect(familiesOf([], map)).toEqual([])
  })
})

describe('executivePowerOf', () => {
  const at = (form: Parameters<typeof executivePowerOf>[0], prose: string[], hog = true) =>
    executivePowerOf(form, prose, hog)

  it('gives a presidential republic to its president', () => {
    expect(at('presidential_republic', ['Federal presidential republic'])).toBe('head_of_state')
  })

  it('gives a parliamentary system to its prime minister', () => {
    expect(at('parliamentary_republic', ['Federal parliamentary republic'])).toBe(
      'head_of_government'
    )
    expect(at('constitutional_monarchy', ['Unitary parliamentary monarchy'])).toBe(
      'head_of_government'
    )
  })

  // The 28 semi-presidential republics are the reason this field exists: the
  // label covers France, where the president governs, and Austria, where the
  // chancellor does. The article's own prose separates them.
  it('splits the semi-presidential republics on their prose', () => {
    expect(at('semi_presidential_republic', ['Unitary semi-presidential republic'])).toBe(
      'head_of_state'
    )
    expect(
      at('semi_presidential_republic', ['federal parliamentary republic', 'semi-presidential system'])
    ).toBe('head_of_government')
  })

  it('reads a parliamentary system through a misclassified form', () => {
    // Pakistan's form keyword-matches "Islamic" to `theocracy`, which would
    // hand the country to its president; the prose says otherwise and wins.
    expect(at('theocracy', ['Federal parliamentary Islamic republic'])).toBe('head_of_government')
  })

  it('calls a shared executive collective, even with no head of government', () => {
    // Switzerland records no separate head of government because the Federal
    // Council holds both roles as a body — so this is checked BEFORE the
    // single-officeholder shortcut, or a seven-member collective reads as one
    // head of state.
    expect(at('presidential_republic', ['directorial system', 'federal republic'], false)).toBe(
      'collective'
    )
  })

  it('does not let a stale parliamentary label unseat a president', () => {
    // P122 returns unranked multi-values mixing the current with the
    // historical. Tunisia carries "parliamentary republic" beside "Unitary
    // presidential republic"; its 2022 constitution gives the president sole
    // control of the executive. Kyrgyzstan is the same shape after 2021.
    expect(
      at('presidential_republic', [
        'parliamentary republic',
        'semi-presidential system',
        'Unitary presidential republic',
      ])
    ).toBe('head_of_state')
    expect(
      at('presidential_republic', ['parliamentary republic', 'Unitary presidential republic'])
    ).toBe('head_of_state')
  })

  it('still rescues a misclassified form from its prose', () => {
    // The override may only RESCUE, never overrule — Pakistan keyword-matches
    // "Islamic" to `theocracy` and must still reach Shehbaz Sharif.
    expect(
      at('theocracy', [
        'federal republic',
        'parliamentary republic',
        'Federal parliamentary Islamic republic',
      ])
    ).toBe('head_of_government')
    // Genuinely premier-led semi-presidential republics keep the override.
    expect(
      at('semi_presidential_republic', ['parliamentary republic', 'Semi-presidential republic'])
    ).toBe('head_of_government')
  })

  it('keeps a premier-led dictatorship with its premier', () => {
    // "Dictatorship" says WHO rules, not WHICH OFFICE. Cambodia's Hun Manet
    // and Togo's Faure Gnassingbé ARE the heads of government; reading the
    // word alone handed both to a ceremonial king and a figurehead president.
    expect(
      at('constitutional_monarchy', [
        'constitutional monarchy',
        'Unitary parliamentary constitutional elective monarchy under a hereditary dictatorship',
      ])
    ).toBe('head_of_government')
    expect(
      at('parliamentary_republic', [
        'Unitary parliamentary republic under an authoritarian dictatorship',
      ])
    ).toBe('head_of_government')
  })

  it('reads a semi-presidential autocracy as president-led', () => {
    // Congo-Brazzaville: "under an authoritarian dictatorship" beside a stale
    // "parliamentary republic". Sassou Nguesso has ruled since 1997 and
    // appoints the premier, who was reappointed days after resigning.
    expect(
      at('semi_presidential_republic', [
        'parliamentary republic',
        'Unitary semi-presidential republic under an authoritarian dictatorship',
      ])
    ).toBe('head_of_state')
  })

  it('gives both offices to one person where there is no head of government', () => {
    expect(at('presidential_republic', ['Federal presidential republic'], false)).toBe(
      'head_of_state'
    )
  })
})

describe('trustedHolder', () => {
  const held = (id: string, rank: string, opts: { ended?: boolean; start?: string } = {}) =>
    ({
      rank,
      mainsnak: { datavalue: { value: { id } } },
      qualifiers: {
        ...(opts.ended ? { P582: [{}] } : {}),
        ...(opts.start
          ? { P580: [{ datavalue: { value: { time: `+${opts.start}T00:00:00Z` } } }] }
          : {}),
      },
    }) as never

  const idOf = (statement: ReturnType<typeof trustedHolder>) =>
    (statement as { mainsnak?: { datavalue?: { value?: { id?: string } } } } | undefined)?.mainsnak
      ?.datavalue?.value?.id

  it('names the open holder of a maintained office', () => {
    expect(
      idOf(
        trustedHolder([
          held('Q_old', 'normal', { ended: true, start: '2015-01-01' }),
          held('Q_now', 'normal', { start: '2023-01-01' }),
        ])
      )
    ).toBe('Q_now')
  })

  it('refuses an office whose past holders are marked deprecated', () => {
    // Nepal: the three real presidents sit deprecated and closed, leaving the
    // VICE president as the only open holder. An office that calls its own
    // history false is not evidence — fall through to the country item, which
    // had Ram Chandra Poudel right.
    expect(
      trustedHolder([
        held('Q_president_1', 'deprecated', { ended: true, start: '2008-07-21' }),
        held('Q_president_2', 'deprecated', { ended: true, start: '2015-10-29' }),
        held('Q_president_3', 'deprecated', { ended: true, start: '2023-03-13' }),
        held('Q_vice_president', 'normal', { start: '2025-09-09' }),
      ])
    ).toBeUndefined()
  })

  it('treats an all-closed office as a vacancy rather than an answer', () => {
    expect(
      trustedHolder([held('Q_departed', 'normal', { ended: true, start: '2019-01-01' })])
    ).toBeUndefined()
  })
})

describe('resolveStatement', () => {
  const at = (start: string, opts: { ended?: boolean; rank?: string } = {}) =>
    ({
      rank: opts.rank ?? 'normal',
      mainsnak: { datavalue: { value: { id: `Q_${start}` } } },
      qualifiers: {
        P580: [{ datavalue: { value: { time: `+${start}T00:00:00Z` } } }],
        ...(opts.ended ? { P582: [{}] } : {}),
      },
    }) as never

  const idOf = (r: ReturnType<typeof resolveStatement>) =>
    (r.statement as { mainsnak?: { datavalue?: { value?: { id?: string } } } } | undefined)?.mainsnak
      ?.datavalue?.value?.id

  it('takes the latest open term that has begun', () => {
    const r = resolveStatement([at('2019-01-01', { ended: true }), at('2023-03-13')], '2026-08-15')
    expect(idOf(r)).toBe('Q_2023-03-13')
    expect(r.stale).toBe(false)
  })

  it('ignores a term that has not started yet', () => {
    // Hungary: András Baka was elected 11 Aug 2026 to take office on the 19th.
    // "Latest start wins" actively PREFERS a president-elect, so he was
    // published as the sitting president four days early.
    const r = resolveStatement(
      [at('2024-03-05', { ended: true }), at('2026-08-19')],
      '2026-08-15'
    )
    // The office is genuinely empty until the 19th — falling through to the
    // last real holder and reporting `stale` is the truthful answer.
    expect(idOf(r)).toBe('Q_2024-03-05')
    expect(r.stale).toBe(true)
  })

  it('accepts the term on the day it begins', () => {
    const r = resolveStatement([at('2026-08-15')], '2026-08-15')
    expect(idOf(r)).toBe('Q_2026-08-15')
    expect(r.stale).toBe(false)
  })

  it('keeps a dateless statement, having nothing to disqualify it on', () => {
    const undated = { rank: 'normal', mainsnak: { datavalue: { value: { id: 'Q_undated' } } } }
    expect(idOf(resolveStatement([undated as never], '2026-08-15'))).toBe('Q_undated')
  })
})

describe('resolveStatement — a term with a future end date', () => {
  const term = (start: string, end?: string, rank = 'normal') =>
    ({
      rank,
      mainsnak: { datavalue: { value: { id: `Q_${start}` } } },
      qualifiers: {
        P580: [{ datavalue: { value: { time: `+${start}T00:00:00Z` } } }],
        ...(end ? { P582: [{ datavalue: { value: { time: `+${end}T00:00:00Z` } } }] } : {}),
      },
    }) as never

  const idOf = (r: ReturnType<typeof resolveStatement>) =>
    (r.statement as { mainsnak?: { datavalue?: { value?: { id?: string } } } } | undefined)?.mainsnak
      ?.datavalue?.value?.id

  it('serves an interim holder whose term has not ended yet', () => {
    // Hungary's presidency in full: Sulyok to 19 Jul, Forsthoffer interim to
    // 18 Aug, Baka from the 19th. On 15 Aug the answer is Forsthoffer — she is
    // the only one both begun and unfinished.
    const r = resolveStatement(
      [
        term('2024-03-05', '2026-07-19'),
        term('2026-07-20', '2026-08-18'),
        term('2026-08-19', undefined, 'preferred'),
      ],
      '2026-08-15'
    )
    expect(idOf(r)).toBe('Q_2026-07-20')
    expect(r.stale).toBe(false)
  })

  it('retires that same holder once the date passes', () => {
    const r = resolveStatement(
      [term('2026-07-20', '2026-08-18'), term('2026-08-19', undefined, 'preferred')],
      '2026-08-20'
    )
    expect(idOf(r)).toBe('Q_2026-08-19')
    expect(r.stale).toBe(false)
  })

  it('treats an unreadable end date as an ending', () => {
    // Coarser-than-day precision: retire the term rather than invent an
    // incumbency out of a date we cannot compare.
    const vague = {
      rank: 'normal',
      mainsnak: { datavalue: { value: { id: 'Q_vague' } } },
      qualifiers: {
        P580: [{ datavalue: { value: { time: '+2020-00-00T00:00:00Z' } } }],
        P582: [{ datavalue: { value: { time: '+2024-00-00T00:00:00Z' } } }],
      },
    }
    expect(resolveStatement([vague as never], '2026-08-15').stale).toBe(true)
  })
})

describe('personName', () => {
  const person = (label?: string, enwiki?: string) =>
    ({
      ...(label ? { labels: { en: { value: label } } } : {}),
      ...(enwiki ? { sitelinks: { enwiki: { title: enwiki } } } : {}),
    }) as never

  it('keeps the label where the two share a word', () => {
    // Spelling, accents and titles are the common case and the label wins.
    expect(personName(person('Alexander Lukashenka', 'Alexander Lukashenko'))).toBe(
      'Alexander Lukashenka'
    )
    expect(personName(person('Delcy Rodriguez', 'Delcy Rodríguez'))).toBe('Delcy Rodriguez')
    expect(personName(person('Leo XIV', 'Pope Leo XIV'))).toBe('Leo XIV')
    expect(personName(person('Ram Chandra Poudel', 'Ram Chandra Paudel'))).toBe(
      'Ram Chandra Poudel'
    )
  })

  it('takes the article title where the label shares nothing with it', () => {
    // A label is one edit away from anything; a sitelink is a real page. Both
    // of these were live vandalism.
    expect(personName(person('Ben Do', 'Feleti Teo'))).toBe('Feleti Teo')
    expect(personName(person('Edeupa Yerimin', 'Russell Dlamini'))).toBe('Russell Dlamini')
  })

  it('completes a name cut off on a connecting particle', () => {
    // Qatar's emir read "Tamim bin Hamad Al" — the particle is meaningless in
    // final position, so this cannot fire on a complete name.
    expect(personName(person('Tamim bin Hamad Al', 'Tamim bin Hamad Al Thani'))).toBe(
      'Tamim bin Hamad Al Thani'
    )
    // ...and a complete name that merely CONTAINS a particle keeps its label.
    expect(personName(person('Salman bin Abdulaziz Al Saud', 'Salman of Saudi Arabia'))).toBe(
      'Salman bin Abdulaziz Al Saud'
    )
  })

  it('drops a parenthetical disambiguator', () => {
    expect(personName(person('Ali Khamenei', 'Ali Khamenei (politician)'))).toBe('Ali Khamenei')
  })

  it('falls back to whichever field exists', () => {
    expect(personName(person('Only Label'))).toBe('Only Label')
    expect(personName(person(undefined, 'Only Sitelink'))).toBe('Only Sitelink')
  })
})

describe('executivePowerOf — authoritarian monarchies', () => {
  const at = (form: string, raw: string[]) => executivePowerOf(form as never, raw, true, '')

  it('gives an authoritarian monarchy to its crown', () => {
    // Bahrain and Qatar as their own articles describe them. In both the emir
    // appoints the prime minister, approves the cabinet and ratifies laws.
    expect(
      at('constitutional_monarchy', [
        'constitutional monarchy',
        'Unitary constitutional monarchy under an authoritarian government',
      ])
    ).toBe('head_of_state')
    expect(
      at('constitutional_monarchy', [
        'constitutional monarchy',
        'Unitary authoritarian semi-constitutional monarchy',
      ])
    ).toBe('head_of_state')
  })

  it('leaves every ordinary constitutional monarchy premier-led', () => {
    for (const raw of [
      ['constitutional monarchy', 'Unitary parliamentary constitutional monarchy'],
      ['constitutional monarchy', 'Federal parliamentary constitutional elective monarchy'],
      ['constitutional monarchy', 'Unitary parliamentary semi-constitutional monarchy'],
    ]) {
      expect(at('constitutional_monarchy', raw)).toBe('head_of_government')
    }
  })
})

describe('executivePowerOf — an executive presidency', () => {
  const at = (form: string, raw: string[]) => executivePowerOf(form as never, raw, true, '')

  it('outranks "parliamentary" in the same sentence', () => {
    // Guyana says both: "Unitary parliamentary republic WITH AN EXECUTIVE
    // PRESIDENCY". The president is head of state and head of government; the
    // prime minister is constitutionally the first vice president.
    // "Parliamentary" describes how the legislature is composed, "executive
    // presidency" who runs the government — which is what this asks.
    expect(
      at('parliamentary_republic', [
        'parliamentary republic',
        'Unitary parliamentary republic with an executive presidency',
      ])
    ).toBe('head_of_state')
  })

  it('leaves an ordinary parliamentary republic with its premier', () => {
    expect(
      at('parliamentary_republic', ['federal parliamentary republic', 'Federal parliamentary republic'])
    ).toBe('head_of_government')
  })
})
