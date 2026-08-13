import {
  BLOC_KINDS,
  CHAMBER_ROLES,
  CONFIDENCE,
  CONTESTATION,
  GOVERNMENT_FORMS,
  SPECTRUM_BANDS,
  STANDINGS,
} from '../types/enums'
import type { Polity, PolityDataset } from '../types/polity'

/**
 * What the dataset says about itself, checked.
 *
 * The extraction step is the one place a language model touches the data, and
 * this is what makes that safe: every number it returned is checked against a
 * total it did not supply. A hallucinated seat count fails a sum here rather
 * than shipping as a plausible wrong number.
 *
 * Failures are REPORTED, never repaired. A dataset that quietly corrects itself
 * is one nobody can audit — and the `confidence` field exists precisely so a
 * consumer can see the disagreement rather than be protected from it.
 */

export interface Issue {
  iso: string
  chamber?: string
  severity: 'error' | 'warning'
  message: string
}

const QID = /^Q\d+$/

export const validateDataset = (dataset: PolityDataset): Issue[] => {
  const issues: Issue[] = []
  const note = (iso: string, severity: Issue['severity'], message: string, chamber?: string) =>
    issues.push({ iso, severity, message, ...(chamber ? { chamber } : {}) })

  for (const [iso, polity] of Object.entries(dataset.countries)) {
    validateCountry(iso, polity, note)
  }
  return issues
}

const validateCountry = (
  iso: string,
  polity: Polity,
  note: (iso: string, severity: Issue['severity'], message: string, chamber?: string) => void
): void => {
  if (!/^[A-Z]{2}$/.test(polity.iso)) note(iso, 'error', `iso "${polity.iso}" is not alpha-2`)
  if (!QID.test(polity.entity.qid)) note(iso, 'error', `entity qid "${polity.entity.qid}" malformed`)
  if (!GOVERNMENT_FORMS.includes(polity.form)) note(iso, 'error', `unknown form "${polity.form}"`)

  // A sovereign state has a head of state. Nothing else is a fact about
  // every country, which is why this is the only presence check.
  if (!polity.head_of_state) note(iso, 'error', 'no head of state')

  // The null is load-bearing: it means one person holds both offices. A
  // head of government that merely REPEATS the head of state is the bug it
  // exists to prevent.
  if (
    polity.head_of_government &&
    polity.head_of_government.person.qid === polity.head_of_state?.person.qid
  ) {
    note(iso, 'error', 'head of government duplicates head of state instead of being null')
  }

  if (!polity.chambers.length) note(iso, 'error', 'no chambers')

  const roles = polity.chambers.map(chamber => chamber.role)
  if (roles.includes('unicameral') && roles.length > 1) {
    note(iso, 'error', `unicameral alongside ${roles.filter(r => r !== 'unicameral').join('+')}`)
  }
  if (new Set(roles).size !== roles.length) note(iso, 'error', `duplicate chamber roles: ${roles.join('+')}`)

  for (const chamber of polity.chambers) {
    const where = chamber.name
    if (!CHAMBER_ROLES.includes(chamber.role)) note(iso, 'error', `bad role "${chamber.role}"`, where)
    if (!CONTESTATION.includes(chamber.contestation)) {
      note(iso, 'error', `bad contestation "${chamber.contestation}"`, where)
    }
    if (!CONFIDENCE.includes(chamber.confidence)) {
      note(iso, 'error', `bad confidence "${chamber.confidence}"`, where)
    }

    const seated = chamber.composition.reduce((total, row) => total + row.seats, 0)

    // THE check. The model reported the rows; `seats_total` came from
    // Wikidata's P1342, which it never saw. Agreement between two
    // independent sources is what makes an extracted number trustworthy.
    if (chamber.seats_total > 0 && seated > 0) {
      const drift = Math.abs(seated - chamber.seats_total) / chamber.seats_total
      if (drift > 0.02 && chamber.confidence !== 'flagged') {
        note(
          iso,
          'error',
          `seats sum to ${seated} against a declared ${chamber.seats_total} but confidence is "${chamber.confidence}"`,
          where
        )
      }
      // A nested list read at two levels lands near double the real size.
      if (seated > chamber.seats_total * 1.5) {
        note(iso, 'warning', `seated ${seated} is far above ${chamber.seats_total} — nested list read twice?`, where)
      }
    }

    if (!chamber.composition.length && chamber.confidence !== 'flagged') {
      note(iso, 'error', 'empty composition without being flagged', where)
    }

    for (const row of chamber.composition) {
      if (!STANDINGS.includes(row.standing)) note(iso, 'error', `bad standing "${row.standing}"`, where)
      if (row.party !== null && !QID.test(row.party)) {
        note(iso, 'error', `bad party ref "${row.party}"`, where)
      }
      // Every referenced party must be IN the registry, or the reference is a
      // dangling pointer and a consumer resolving it gets nothing.
      if (row.party && !polity.parties[row.party]) {
        note(iso, 'error', `row "${row.name}" points at ${row.party}, absent from the registry`, where)
      }
      if (row.seats < 0) note(iso, 'error', `negative seats on "${row.name}"`, where)
      if (row.share < 0 || row.share > 1) note(iso, 'error', `share ${row.share} out of range`, where)
    }
  }

  for (const [qid, party] of Object.entries(polity.parties)) {
    if (!QID.test(qid)) note(iso, 'error', `party key "${qid}" malformed`)
    if (party.entity.qid !== qid) note(iso, 'error', `party ${qid} carries entity ${party.entity.qid}`)
    if (!BLOC_KINDS.includes(party.kind)) note(iso, 'error', `party ${qid} bad kind "${party.kind}"`)
    if (party.alignment && !SPECTRUM_BANDS.includes(party.alignment)) {
      note(iso, 'error', `party ${qid} bad alignment "${party.alignment}"`)
    }
    for (const colour of party.colors) {
      if (!/^#[0-9a-f]{6}$/.test(colour)) note(iso, 'warning', `party ${qid} colour "${colour}" not hex`)
    }
    // A non-free image must name its source. This is the rule that keeps a
    // fair-use pointer honest rather than quiet.
    if (party.logo?.non_free && !party.logo.credit && !party.logo.license) {
      note(iso, 'warning', `party ${qid} ships a non-free logo with no licence or credit`)
    }
  }

  // The government must be drawn from the house that forms one.
  const primary =
    polity.chambers.find(chamber => chamber.role === 'lower') ??
    polity.chambers.find(chamber => chamber.role === 'unicameral')
  if (primary) {
    const seatedGovernment = primary.composition
      .filter(row => row.standing === 'government')
      .reduce((total, row) => total + row.seats, 0)
    if (polity.government.seats !== seatedGovernment) {
      note(
        iso,
        'error',
        `government claims ${polity.government.seats} seats, the chamber seats ${seatedGovernment}`
      )
    }
    const expectedMinority =
      primary.seats_total > 0 && polity.government.seats * 2 <= primary.seats_total
    if (polity.government.minority !== expectedMinority) {
      note(iso, 'error', `minority is ${polity.government.minority}, seats say ${expectedMinority}`)
    }
    for (const qid of [...polity.government.governing, ...polity.government.backing]) {
      if (!polity.parties[qid]) note(iso, 'error', `government names ${qid}, absent from the registry`)
    }
  }
}

/** A one-line summary for the run log. */
export const summarise = (dataset: PolityDataset, issues: Issue[]): string => {
  const errors = issues.filter(issue => issue.severity === 'error').length
  const warnings = issues.length - errors
  return `${Object.keys(dataset.countries).length} countries, ${errors} errors, ${warnings} warnings`
}
