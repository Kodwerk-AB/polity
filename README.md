# polity

**Every country's government, parliament and parties — as structured, typed, verifiable data.**

A statically generated JSON file, rebuilt on a schedule, describing who governs
each country: the head of state and the head of government, every chamber of the
legislature, every party seated in it, how many seats each holds, and whether it
is in government, supporting it, or opposing it.

Free to use, hosted on GitHub, no API key, no rate limit.

---

## Why this exists

Nothing provides this. That is not an assumption — it was checked:

| Project | Status | Why it does not fill the gap |
| --- | --- | --- |
| **EveryPolitician** (mySociety) | **Dead — June 2019** | Tracked *people*, not seat aggregates. Quit because "there is an election somewhere roughly once a week" |
| **ParlGov** | **Dead — October 2024** | Had exactly this data model. Maintainer retired, no successor. 37 countries, ends June 2023 |
| **IPU Parline** | Alive | ~200 attributes per chamber, **no party breakdown** at all |
| **Wikidata** | Alive | Only **2 national legislatures** carry usable party-seat data |
| **CLEA / CPDS / V-Dem** | Alive | Election *results archives* and indices — not current composition |
| **PolitPro / Europe Elects** | Alive | **Poll projections**, not real parliaments. Terms forbid derived platforms |

The distinction that matters: **election results archives are abundant; current
composition is not.** They differ because composition drifts continuously after
election day — defections, by-elections, coalition collapses, splits. An archive
is a snapshot; this is the live state.

Downstream consumers have no shared upstream. Wikipedia infoboxes are
hand-maintained by editors. News organisations keep it in-house and unpublished.
Academia uses the frozen or the two-years-lagged.

### Why it stayed empty

Not difficulty — **maintenance load**. mySociety had funding and paid staff and
still stopped. ParlGov ended when one academic retired.

This project's answer is to make the steady state cost almost nothing:

- Resolve every country's legislature **deterministically** from Wikidata's own
  graph, so no link is hand-maintained.
- Hash the **source field** each composition is read from. Measured across six
  busy legislature articles and 120 revisions spanning 11–168 days: the
  composition field **never changed once**, while 18 of 20 pages were edited
  within 90 days. Gating on the page's revision would re-extract constantly;
  gating on the field's hash collapses it to real elections.
- Invoke a language model **only for what actually changed**. At measured sizes
  that is ~$0.24 for a full cold rebuild and ~$0.21/year in steady state.

---

## Design

### Everything is keyed, not matched

Every entity carries its Wikidata Q-id beside its human label. String matching
between sources is the thing that fails: `Conservative People's Party` and
`Conservative People's Party or DKF` are the same party, and no string
comparison says so.

### Chambers are always an array

One entry for a unicameral legislature, two for a bicameral one. The shape never
changes, so a consumer writes one code path and never an `if (bicameral)`
branch. Pick by `role`, never by index — sources list houses in no reliable
order.

### Chamber roles resolve by subclass, not by class

Measured across 40 countries, the lower house is filed as at least four
different Wikidata classes: `Q375928` (Germany), `Q2145277` (Australia),
`Q320289` (Brazil), `Q9247597` (Britain, Canada). Matching the exact id resolved
25 of 40. Walking `P279` (subclass of) upward resolves them all.

### Standing is not a boolean

Sweden's government is M+KD+L; the Sweden Democrats hold no ministries and
supply the majority. Government overstates them, opposition is simply false. So
`backing` is its own value — along with `speaker`, `non_attached` and `vacant`,
because real chambers seat those and the arithmetic does not balance without
them.

### Head of state ≠ head of government

Sometimes one person (El Salvador, the United States), sometimes two (Britain,
Germany). When one person holds both, `head_of_government` is explicitly `null`
rather than a repeated entry — so "the same person" is distinguishable from "we
only found one". `represents` records which office speaks *politically* and
which *ceremonially*.

### Opposition is derived, never read

Only the government side is taken from the source; opposition is everything left
over. A source's own "opposition" field is populated for a fraction of
countries, while the seated blocs are held in full — so deriving is both better
covered and impossible to leave inconsistent with the composition beside it.

### An alliance is not a party

`kind` distinguishes a party from an electoral alliance, a parliamentary group,
independents and the chamber's own bookkeeping rows. "Which party governs?" has
no honest answer when the answer is an alliance of five.

### Provenance and confidence ship with the data

Every value records whether it was read from a structured property, parsed
deterministically, extracted by a language model, or entered by hand — plus the
exact `revid` read. `confidence` is `high | partial | flagged`, in the data
rather than a log, because a consumer must be able to tell a verified row from a
guessed one without re-reading the source.

### Images are pointers, never re-hosted

Logos are published as a Commons filename plus a `Special:FilePath` URL, with
the licence and a `non_free` flag. Each consumer applies its own policy. Storing
the filename rather than a baked thumbnail URL survives renames and lets the
consumer pick its own width.

---

## Status

**Early. The schema is designed and typed; the pipeline is not built yet.**

- [x] Schema and enums, strict-typed
- [x] Chamber resolution rule, verified against 40 countries
- [x] Change-detection strategy, measured
- [ ] Resolver
- [ ] Extractor and validator
- [ ] Scheduled rebuild
- [ ] First published dataset

## Licence

Code MIT. Data ODbL — it is derived from Wikidata (CC0) and Wikipedia (CC BY-SA).
