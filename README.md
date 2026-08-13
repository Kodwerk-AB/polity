# polity

**Every country's government, parliament and parties — as structured, typed, verifiable data.**

One JSON file, rebuilt on a schedule, describing who governs each of the 193 UN
member states: the head of state and the head of government, every chamber of
the legislature, every party seated in it, how many seats each holds, and
whether it is in government, supporting it, or opposing it.

Free to use. No API key, no rate limit, no hosting cost.

```jsonc
{
  "SV": {
    "form": "presidential_republic",
    "head_of_state":      { "name": "Nayib Bukele", "represents": "political", "party": { "qid": "Q61692310" } },
    "head_of_government": null,               // the same person holds both
    "chambers": [{
      "role": "unicameral",
      "name": "Legislative Assembly",
      "name_local": "Asamblea Legislativa",
      "seats_total": 60,
      "contestation": "competitive",
      "mandate": { "years_since_election": 2.5, "state": "current" },
      "composition": [
        { "party": "Q61692310", "name": "Nuevas Ideas", "seats": 54, "standing": "government" },
        { "party": "Q752132",   "name": "ARENA",        "seats": 2,  "standing": "opposition" }
      ],
      "confidence": "high"
    }]
  }
}
```

---

## Why this exists

Nothing provides this. That was checked, not assumed:

| Project | Status | Why it does not fill the gap |
| --- | --- | --- |
| **EveryPolitician** (mySociety) | **Dead — June 2019** | Tracked *people*, not seat aggregates. Quit because "there is an election somewhere roughly once a week" |
| **ParlGov** | **Dead — October 2024** | Had exactly this model. Maintainer retired, no successor. 37 countries, ends June 2023 |
| **IPU Parline** | Alive | ~200 attributes per chamber, **no party breakdown** at all |
| **Wikidata** | Alive | Only **2 national legislatures** carry usable party-seat data |
| **CLEA / CPDS / V-Dem** | Alive | Election *results archives* and indices — not current composition |
| **PolitPro / Europe Elects** | Alive | **Poll projections**, not real parliaments. Terms forbid derived platforms |

The distinction that matters: **results archives are abundant; current
composition is not.** They differ because composition drifts continuously after
election day — defections, by-elections, coalition collapses, splits.

### Why it stayed empty, and what is different here

Not difficulty — **maintenance load**. mySociety had funding and paid staff and
stopped anyway.

The answer is to make the steady state cost almost nothing:

- Every country's legislature resolves **deterministically** from Wikidata's own
  graph. No link table is hand-maintained.
- Each composition is keyed by a **hash of the source field**. Measured across
  six busy articles and 120 revisions spanning 11–168 days, the composition
  field never changed once, while 18 of 20 pages were edited within 90 days.
  Gating on the page's revision would re-extract constantly; gating on the
  field's hash collapses it to real elections.
- A language model is invoked **only for what changed**. A full cold rebuild is
  ~$0.24; steady state is ~$0.21/year.
- `mandate` says which chambers are near the end of a term, so a consumer
  re-checks the handful that matter instead of distrusting all 193.

---

## How it works

```
UN members     P463 → Q1065, open statements          193 states
   ↓
chambers       P194, then P279 walked upward          273 chambers
   ↓
source         political_groups field, hashed         follows one transclusion
   ↓
extract        Haiku, strict tool schema              only on hash change
   ↓
resolve        wikilink → Q-id → ideology, logo…      88% of seat rows
   ↓
validate       seats vs P1342, refs, enums            errors published, not fixed
```

The model does one thing: read markup a human wrote for other humans and report
its structure. It is never asked to recall anything. Every number it returns is
present in the text it was handed, and is then checked against a total from
Wikidata that it never saw — so a hallucination fails a sum rather than shipping.

---

## Design

**Everything is keyed, not matched.** Every entity carries its Wikidata Q-id
beside its label. String matching between sources is the thing that fails:
`Conservative People's Party` and `Conservative People's Party or DKF` are the
same party and no string comparison says so.

**Chambers are always an array.** One entry unicameral, two bicameral. The shape
never changes, so a consumer writes one code path. Pick by `role`, never index.

**Chamber roles resolve by subclass.** Across 40 countries the lower house is
filed under at least four Wikidata classes — `Q375928` (Germany), `Q2145277`
(Australia), `Q320289` (Brazil), `Q9247597` (Britain, Canada). Exact matching
resolved 25 of 40; walking `P279` resolves all 193.

**Standing is not a boolean.** Sweden's government is M+KD+L; the Sweden
Democrats hold no ministries and supply the majority. So `backing` is its own
value — with `speaker`, `non_attached` and `vacant`, because real chambers seat
those and the arithmetic does not balance without them.

**Head of state ≠ head of government.** When one person holds both,
`head_of_government` is explicitly `null` rather than a repeated entry — so "the
same person" is distinguishable from "we only found one". `represents` records
which office speaks *politically* and which *ceremonially*: Germany's Chancellor
at the G7, the President signing treaties.

**Contestation is its own axis.** North Korea's Supreme People's Assembly is a
real building with real members who really meet; what is fictional is the
contest. Recording it as an ordinary parliament would be false and omitting the
country would be worse, so `contestation` carries the judgement — a chamber can
be bicameral, directly elected AND `uncontested`.

**An alliance is not a party.** `kind` separates a party from an electoral
alliance, a parliamentary group, independents and the chamber's own bookkeeping.
"Which party governs?" has no honest answer when the answer is an alliance of
five.

**Opposition is derived, never read.** Only the government side is taken from
the source; opposition is everything left over. A source's own "opposition"
field is populated for a fraction of countries where the seated blocs are held
in full.

**Provenance and confidence ship with the data.** Every value records whether it
was read from a structured property, parsed, extracted by a model, or entered by
hand — plus the exact `revid`. `confidence` is `high | partial | flagged`, in
the data rather than a log.

**Images are pointers.** A Commons filename plus a `Special:FilePath` URL, with
the licence and a `non_free` flag. Each consumer applies its own policy.

---

## Use

```bash
curl -s https://raw.githubusercontent.com/USER/polity/main/data/polity.json
```

```bash
bun install
bun run build            # full rebuild (cached; near-free after the first)
bun run build SV NO KP   # a few countries, into data/sample.json
bun run build:schema     # regenerate schema/openapi.json from the types
bun run test
```

`CLAUDE_KEY` must be set for extraction. Everything else needs no credentials.

## Licence

Code MIT. Data ODbL — derived from Wikidata (CC0) and Wikipedia (CC BY-SA).
