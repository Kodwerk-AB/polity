# How each judgement is made

Most fields in this dataset are read from a source and reported. A few are
**judgements** — `contestation`, `selection`, `form`, `standing`, `authority`,
`confidence` — where the sources disagree, say nothing, or say something that
needs interpreting.

This file states each rule, in the order it fires, with the case that forced it.
It exists so a consumer can decide whether they agree, and re-derive a different
answer from the same fields if they do not.

The counts below are from the current build: **196 countries, 276 chambers,
2,108 seat rows, 1,403 parties.**

---

## `selection` — how members reach their seats

**Read from the chamber article's `voting_system` field.** Multiple values are
reported where a chamber uses more than one method.

| Pattern in `voting_system` | Value |
| --- | --- |
| "direct", "proportional representation", "first-past-the-post", "party-list", "two-round", "single transferable", "universal suffrage" | `directly_elected` |
| "indirect", "electoral college", "elected by the state/regional/provincial…" | `indirectly_elected` |
| "appointed", "appointment", "nominated by", "hereditary" | `appointed` |
| field absent or empty | `role` default: `indirectly_elected` for an upper house, `directly_elected` otherwise |

Result: `directly_elected` 215, `indirectly_elected` 48, `appointed` 27.

**Why not infer it from `role`.** That was the original rule — every upper house
`indirectly_elected` — and it is wrong in both directions. Australia's,
Palau's and Micronesia's upper chambers are directly elected; Canada's,
Jamaica's and Antigua's are appointed outright. The guess produced 12 chambers
reading `directly_elected` and `appointed` simultaneously.

**Mixed chambers are reported as mixed.** Bhutan's National Council is "20 seats
by first-past-the-post, 5 nominated by the Druk Gyalpo" and carries both values.
So does Eswatini's House of Assembly. These are not contradictions.

**An empty field is absent, not a match.** Oman's article leaves
`voting_system` blank; a regex spanning the newline captured the *next* field's
name — `| voting_system2 =` — which matched the elected pattern on the word
"voting" itself. The value must now be on the same line.

---

## `contestation` — whether the seats were actually contested

Four rules, in order. The first that applies wins.

### 1. Where the form is decisive

| `form` | `contestation` |
| --- | --- |
| `one_party_state` | `uncontested` |
| `military_junta`, `transitional` | `suspended` |
| `absolute_monarchy` | `appointed` |
| `theocracy` | `restricted` |
| `dominant_party_state` | `uncontested` at ≥85% dominance, else `restricted` |

A state that permits no rival is not holding a contest whatever its turnout
says. An absolute monarchy's assembly is appointed by the monarch — that is what
makes it an absolute monarchy — so `restricted` overstated it: there is no
contest to restrict.

### 2. A chamber nobody stands for election to

If `selection` says `appointed` and does not also say `directly_elected` →
`appointed`.

Antigua's, Barbados' and Trinidad's senates each seat three or four **named
parties**, because the prime minister and the leader of the opposition appoint
their own people. The benches therefore look exactly like an elected chamber's,
and the arithmetic in rule 4 called all three `competitive`. No contest was
held. Only `voting_system` separates them from Australia's Senate, which is
directly elected and otherwise identical in shape.

### 3. A chamber with no parties in it at all

| Condition | Value |
| --- | --- |
| `selection` includes `appointed` | `appointed` |
| `selection` includes `directly_elected` | `competitive` |
| neither stated, and an upper house or non-empty | `appointed` |
| neither stated, otherwise | `competitive` |

Two very different things look like this. An upper chamber of delegates —
Britain's Lords, Germany's Bundesrat — is appointed and always has been. But so
is a chamber where parties are **banned**: the UAE's Federal National Council
seats 40 members filed as one "Independent" row.

Before `voting_system` was consulted, this branch was reached by anything the
parser could not split into parties, and it filed Micronesia, the Marshall
Islands, Nauru and Palau — directly elected, genuinely contested, non-partisan
legislatures — alongside Saudi Arabia's Shura. Dataset-wide, 28 of 32
`appointed` chambers had fewer than two composition rows and **not one was
`high` confidence**: the value meant "we parsed nothing", not a finding.

### 4. Seat arithmetic

| Condition | Value |
| --- | --- |
| one party holds ≥99% of seats | `uncontested` |
| largest bloc ≥90% | `uncontested` |
| largest bloc ≥75% | `restricted` |
| opposition holds ≤5% | `restricted` |
| no row marked government **or** opposition | `unknown` |
| otherwise | `competitive` |

This exists because `form` is unusable for a third of the world: Wikidata's
`P122` returns nothing for 39 countries and a bare "republic" for 21 more. A
rule that only consulted the label defaulted all of them to `competitive`,
putting Cuba, Belarus, Cambodia, Equatorial Guinea and Turkmenistan in the same
bucket as Denmark.

`unknown` is a real answer. Switzerland files every party `non_attached`
because its executive is elected by the assembly rather than formed from a
majority; judging it on opposition share called one of the world's most
competitive parliaments `restricted`. But silence is not evidence of a contest
either — Tunisia, Kyrgyzstan and Liberia arrive fully unaligned too.

### 5. The landslide check

A verdict of `uncontested` or `restricted` **reached by rule 4** is given back
as `competitive` when V-Dem's electoral democracy index for the country is
**≥ 0.70**.

Seat concentration cannot tell a landslide from a rigged ballot — the two
produce identical numbers. Barbados' governing party took all 30 seats in 2022
in an election nobody disputes, and was called `uncontested` for it. V-Dem
scores Barbados 0.797 and Turkmenistan 0.148.

Three constraints on this:

- **One direction only.** It can clear a verdict, never impose one. A low score
  is never evidence *for* `uncontested`.
- **Only rule 4.** Verdicts from `form` or `voting_system` are evidence about
  the institution, not inferences from counts, and are not overridden.
- **Only an unambiguous score.** The bands overlap in the middle — Senegal
  (0.633) sits above Kenya (0.563), Guatemala (0.637) above the Maldives
  (0.556) — and no cut sorts those correctly. A middling score is treated as no
  evidence at all.

Rescued: Barbados, Mauritius. Unaffected: Belarus (0.163), Cuba (0.176),
Turkmenistan (0.148), Equatorial Guinea (0.172), Azerbaijan (0.171).

Result: `competitive` 158, `appointed` 34, `restricted` 24, `uncontested` 24,
`suspended` 19, `unknown` 14.

---

## `democracy` — the V-Dem score itself

Published on the country so a consumer can apply their own threshold rather
than inherit ours. Sourced from **Our World in Data's CC-BY mirror** of V-Dem's
electoral democracy index, because v-dem.net's own download sits behind a
registration form.

**Covers 172 of 193 members.** The omissions are small states — Antigua,
Belize, Saint Lucia, Monaco, much of the Pacific. Absence is `undefined` and
says nothing about the country: it must never be read as a low score. Four of
the clearest landslide false-positives (Antigua, Belize, Saint Lucia, Monaco)
are in that gap and remain uncorrected.

---

## `form` — the type of state

Taken from Wikidata `P122`, folded to a closed set, then **overridden by the
country article's `government_type` prose** where the two disagree, because the
prose is more specific and more current.

Result: `presidential_republic` 51, `parliamentary_republic` 47,
`constitutional_monarchy` 37, `semi_presidential_republic` 26,
`military_junta` 6, `dominant_party_state` 6, `other` 5, `transitional` 5,
`absolute_monarchy` 4, `theocracy` 3, `one_party_state` 3.

**Known defect.** The prose match is keyword-based and Pakistan's "Federal
parliamentary **Islamic** republic" yields `theocracy`, though the same string
literally contains "parliamentary republic". Mauritania's near-identical
"Unitary semi-presidential Islamic republic" is classified correctly, which
proves the inconsistency. Not yet fixed.

---

## `standing` — which side of the chamber a bloc sits on

Only the **government** side is read from the source; `opposition` is everything
left over. A source's own "opposition" field is populated for a fraction of
countries, so deriving it is both better covered and impossible to leave
inconsistent with the composition beside it.

`backing` is its own value because real chambers seat it: Sweden's government is
M+KD+L, and the Sweden Democrats hold no ministries while supplying the
majority. `speaker`, `non_attached` and `vacant` exist because the arithmetic
does not balance without them.

**Coalition headers are dropped.** Kenya's National Assembly is written as
"Kenya Kwanza — 179", then each of its fourteen member parties, then "Azimio la
Umoja — 158" and its nine. Every row is true, but the chamber seats 349 and the
rows summed to **686**: each seat counted twice, once under its party and once
under its alliance.

The header is identified **only** by the model's own `alliance` parent-link —
never by arithmetic. An earlier version dropped any row whose seats equalled the
sum of the rows beneath it, which is a common coincidence: it deleted the CDU
from the Bundestag and the Conservatives from the Commons. A wrong drop silently
removes a real party, which is worse than the double-count it fixes.

Members are kept and the header dropped, because "which parties sit in this
parliament" is the question the data answers; the alliance survives on each
member's `alliance` field.

---

## `ideology_families` — comparable traditions, alongside the raw labels

Wikidata names **409 distinct ideologies** across 1,394 parties, and **222 of
them appear exactly once**. The top forty cover 70% of mentions; the rest is a
long tail of "Kemalism", "Basque nationalism", "Pancasila", "socialism with
Chinese characteristics".

That tail is the useful part — it is precisely what a reader cannot get
anywhere else — so it is **kept verbatim in `ideologies`**. A closed enum in its
place would delete 30% of what the sources say.

`ideology_families` sits alongside it, from a closed set of twelve, for the
questions the raw labels cannot answer: *which parliaments seat a green party*,
*how many governments are led by Christian democrats*. Comparison across
countries needs a closed vocabulary; describing one party needs the specific
label. Both ship.

**A family is broader than a left-right placement** — that is what `alignment`
is for. Nationalism spans both wings and gets its own family rather than being
forced onto a side. **A party commonly spans several** and all are reported;
collapsing to one would be a judgement the source does not support.

`internationalist` is separate from `nationalist` because folding the two made
the Liberal Democrats and the Green Party of England and Wales read as
nationalist parties on the strength of "pro-Europeanism" alone — a position most
of the European centre holds. A bloc stance is not a claim about who the nation
is.

**Classified by the model, keyed by Q-id.** The alternative was a hand-written
table of 409 identifiers, and the first attempt at exactly that was written from
memory and contained **44 Q-ids that do not exist** — a fabricated `Q1379xxx`
run among them. Every Q-id now comes from the data that was just built, so the
map cannot contain an identifier that does not occur, and the model only sorts
labels it is shown. Answers are cached per ideology, so a rebuild classifies
only what is new.

---

## `executive_power` — which office actually runs the government

The field to read when asking *who leads this country*. Protocol rank does not
settle it, and neither does `represents`.

| condition | value |
| --- | --- |
| prose names a directorial system, federal council or ruling council | `collective` |
| no separate head of government | `head_of_state` |
| prose names a parliamentary republic / system / democracy | `head_of_government` |
| `presidential_republic`, `one_party_state`, `dominant_party_state`, `theocracy`, `military_junta` | `head_of_state` |
| `absolute_monarchy` | `head_of_state` |
| `parliamentary_republic` | `head_of_government` |
| `constitutional_monarchy` | `head_of_government`, unless the prose still says "absolute monarchy" |
| `semi_presidential_republic` | prose decides; president by default |
| anything else | `head_of_state` |

Result: `head_of_state` 105, `head_of_government` 90, `collective` 1.

**Two simpler rules were tried first and both failed**, in opposite directions,
which is why this field exists rather than being derived at read time.

Keying on **`represents`** put Austria's Van der Bellen above Chancellor
Stocker, Poland's Nawrocki above Tusk and Pakistan's Zardari above Sharif — 13
wrong, because `represents` marks the head of state `political` for every
semi-presidential republic whether or not the presidency governs.

Keying on **"a head of government exists"** was worse: 39 wrong, including Li
Qiang above Xi Jinping, Mishustin above Putin and Lecornu above Macron. In
presidential and one-party systems the premier is a subordinate.

**The semi-presidential republics are the hard set** — 28 of them, and the
label covers France, where the president governs, and Austria, where the
chancellor does. The article's prose separates 20: Austria's reads "federal
parliamentary republic", Azerbaijan's and Belarus' read "presidential system".
The remaining eight say neither and genuinely split, so the president is the
default and the two exceptions are named: Portugal and São Tomé, both verified
against current reporting.

**Individually verified against sources, not inferred:**

- **Portugal** — the prime minister is chief executive; the president is a
  check on national security and foreign policy.
- **Cuba** — the 2019 constitution restored a premiership to run the Council of
  Ministers day to day. *"The president is the one who leads."*
- **UAE** — the president (ruler of Abu Dhabi) appoints the prime minister
  (ruler of Dubai), so the premiership divides authority between emirates
  rather than transferring it. Its own article calls the state an absolute
  monarchy, which is what the `constitutional_monarchy` branch tests for.
- **Switzerland** — the Federal Council's seven members share the executive and
  the presidency rotates yearly. Checked BEFORE the single-officeholder
  shortcut, since Switzerland records no separate head of government.
- **Pakistan** — `form` keyword-matches "Islamic" to `theocracy`, which would
  hand the country to President Zardari. The prose says "Federal parliamentary
  Islamic republic" and Shehbaz Sharif governs; prose outranks `form` here.

**Known defect it inherits.** Canada reads `head_of_state` because
`head_of_government` is null upstream — the field is correct given its input,
and the input is wrong.

---

## `confidence` — how far to trust a chamber

| Value | When |
| --- | --- |
| `flagged` | no composition at all, or the seats do not sum, or the mandate has expired, or no party was named, or a newer election exists |
| `partial` | some rows unresolved, or the source was imprecise, or no election date, or mostly residual rows |
| `high` | none of the above |

Result: `high` 156, `partial` 47, `flagged` 70.

`flagged` is not a hidden record — it ships, with the reason. Errors are
published rather than fixed silently, because a consumer that knows a chamber
is doubtful can route around it, and one handed a confident wrong answer cannot.

---

## What a full audit finds

Every country was checked against six rules: `executive_power` must name
somebody, no leader may be a placeholder or a governor general or carry markup,
the same person must not fill both offices, a chamber must not seat more members
than it has, and a government block must not be empty where a chamber is seated.

**Zero high-severity findings.** No placeholder names, no representatives in a
head-of-state slot, no markup in a name, and every country resolves to a named
leader.

**21 chambers seat more members than they hold**, and every one of them is
already `flagged` or `partial` — none claims high confidence. The cause is
usually `{{efn}}` footnote nesting: Bolivia's senate lists PDC (16) and Unity
(7) as government, then restates their member parties *inside footnotes*, so a
flat reading counts 44 seats in a 36-seat chamber. Senegal's +10 is the same
shape.

A greedy fix — keep the largest rows that sum to the declared size — reconciles
all of them exactly, and is wrong: it deletes real parties to make arithmetic
work. That is the same error as the alliance-header rule that once removed the
CDU from the Bundestag. The rows stay, the chamber stays flagged, and the
consumer is told rather than misled.

**29 countries have an empty government block**, and most legitimately:

| why | count |
| --- | --- |
| the chamber is `appointed` (Gulf monarchies, Eswatini) | 5 |
| the chamber is `suspended` (Libya, Myanmar, Syria, Sudan…) | 6 |
| `contestation: unknown` — the source lists parties but never marks sides | 10 |
| genuinely non-partisan or collective (Switzerland, Micronesia, Nauru…) | 6 |
| `uncontested` one-party states | 2 |

The `unknown` group is the honest one: Senegal's article is a flat list of
parties and seats with no government or opposition heading anywhere in it, so
every row reads `non_attached` and no government can be derived. Inventing one
would assert something the source does not say.

---

## Known open defects

Stated plainly rather than left for a consumer to discover:

- **Kazakhstan** — the 2026 constitution abolished both chambers on 1 July 2026
  and replaced them with a unicameral 145-seat Kurultai, first elected in August
  2026. We still record one 50-seat "Senate". This is upstream lag, not a
  resolver bug: Wikidata's P194 still points at "Parliament of Kazakhstan" with
  the Senate and Mäjilis as its parts, and carries no Kurultai item. The chamber
  is `flagged`, holds zero composition rows, and now carries
  `as_of_is_fallback`. Publishing a 145-seat chamber would assert what no source
  yet says.
- ~~**Nepal** — `head_of_state` names the *Vice* President.~~ **Fixed.** The
  presidency's office item had all three real presidents marked *deprecated* and
  closed, leaving the vice president as its only open holder; the country item
  was correct throughout. An office that calls its own history false is no
  longer read. See "Trusting an office item" below.
- **Pakistan** — `form: theocracy`, described above.
- ~~**`represents`** — all three absolute monarchies read `ceremonial`.~~
  **Fixed.** A crowned head of state was called ceremonial on the title alone
  wherever a prime minister existed, which is right for Britain and Sweden and
  the exact inverse for Brunei, Oman, Saudi Arabia and Eswatini, where the crown
  IS the executive and the premier serves at its pleasure. `form` separates
  them, and is stated outright on all four.
- ~~**`as_of` fallback** — presents a data gap as a fresh observation.~~
  **Disclosed.** The fallback remains (there is no date to report), but it is no
  longer silent: `as_of_is_fallback: true` marks all 49 affected chambers, so a
  gap wearing today's date is now distinguishable from an observation made
  today. It was previously inferable only by comparing `as_of` to
  `retrieved_at` and knowing the rule.
- **Bolivia's Senate** — composition sums to 52 in a 36-seat chamber, with no
  alliance nesting to explain it.

---

## Trusting an office item

Two Wikidata items can name a country's leader, and neither is reliable alone.
The country item (P35/P6) is often years behind, because the statement is written
when a leader arrives and rarely closed when they leave. The office item (P1308)
is maintained where the country is not — so the office is tried first, and the
country is the fallback.

Where they disagree, the tiebreak is the start date: the later one wins, because
a claim nobody dated is a claim nobody has revisited. That is right in seventeen
measured cases and wrong in one.

**Nepal** is the exception, and it is the reason for the rule below. Its
presidency office lists four holders: the three genuine presidents, every one of
them marked `deprecated` *and* closed, and the vice president, open and starting
2025-09-09. On dates alone the vice president wins, so we published him as head
of state — with his own vice-presidential portrait attached.

The fix is not to trust rank across sources. Preferring the country item wherever
it carries a preferred-rank claim was tested and **breaks all seventeen** of the
legitimate cases, because the country's preferred claim is usually the stale one.

The signal is `deprecated` itself. It means *"this statement is false"*, which is
not what happens when a term ends — that is an end date. A president who served
and left is closed, never deprecated. So an office whose past holders are
deprecated has been edited by someone who misread the rank, and nothing it leaves
open is evidence. Measured across every disagreement: all seventeen legitimate
office-wins carry **zero** deprecated holders; Nepal's presidency carries three
of four.

`trustedHolder` refuses such an office outright and lets the country item answer.
