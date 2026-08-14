import { describe, expect, it } from 'vitest'
import { landslideOr, selectionOf } from './build'
import { FREE_ELECTION_SCORE } from './resolve/democracy'

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
