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
      "democracy": { "score": 0.321, "year": 2025, "source": "vdem" },
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
| **CLEA / CPDS / V-Dem** | Alive | Election *results archives* and indices — not current composition. V-Dem's index is used here as one input to `contestation` |
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

It is judged from three signals, in order. **`voting_system`** settles how
members arrive: Antigua's Senate reads "Appointment by the Governor-General"
and Australia's reads "Proportional representation", and no seat count
distinguishes them — both are a handful of rows with no visible contest. Then
**seat concentration**, which is the only signal available for the third of the
world Wikidata's `P122` describes as nothing or as a bare "republic". Then
**V-Dem's electoral democracy index**, which closes the one blind spot
arithmetic has: a landslide and a rigged ballot produce identical numbers.
Barbados won 30 of 30 seats in 2022 in an election nobody disputes and scores
0.797; Turkmenistan wins everything too and scores 0.148.

V-Dem is used in ONE direction — it can clear a chamber the arithmetic
condemned, never condemn one it cleared — and only above 0.7, because the bands
overlap in the middle (Senegal 0.633 sits above Kenya 0.563) and no cut sorts
those correctly. The score ships on the country as `democracy`, so a consumer
can apply its own threshold rather than inherit ours. It covers 176 of 193
members; the omissions are small states, and absence never means a low score.

**Ideologies keep their long tail; families make them comparable.** Wikidata
names 409 distinct ideologies across these parties and 222 appear exactly once —
"Kemalism", "Pancasila", "socialism with Chinese characteristics". That tail is
the useful part, so `ideologies` keeps it verbatim and `ideology_families` sits
alongside from a closed set of thirteen. Comparison across countries needs a
closed vocabulary; describing one party needs the specific label.

**An alliance is not a party.** `kind` separates a party from an electoral
alliance, a parliamentary group, independents and the chamber's own bookkeeping.
"Which party governs?" has no honest answer when the answer is an alliance of
five.

**Opposition is derived, never read.** Only the government side is taken from
the source; opposition is everything left over. A source's own "opposition"
field is populated for a fraction of countries where the seated blocs are held
in full.

**Every judgement is written down.** [DECISIONS.md](DECISIONS.md) states each
derived field's rules in the order they fire, with the case that forced each
one — and the open defects, named. A consumer who disagrees can re-derive a
different answer from the same fields.

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
bun run validate         # check data/polity.json against the schema
bun run test             # unit tests, then schema regeneration and validation
```

The schema seals every object with `additionalProperties: false`, so validation
catches the one class of error nothing else does: a field the generator writes
that the schema never described. The first run of that check found
`government.authority` on all 193 countries, missing from the schema entirely.

`CLAUDE_KEY` must be set for extraction. Everything else needs no credentials.

## Licence

Code MIT. Data ODbL — derived from Wikidata (CC0), Wikipedia (CC BY-SA) and
V-Dem's electoral democracy index (CC-BY, via Our World in Data).
