# The judging engine

This document explains what the engine computes and, where a choice was
judgement rather than mathematics, why it went the way it did. Everything here
lives in `packages/core` as pure functions with no I/O.

The governing idea: **a result should be defensible by the people who lost it.**
That rules out a few convenient designs and forces a few unfashionable ones.

---

## 1. Rubric

A rubric version is a list of criteria. Each has a `maxScore` and a `weight`,
and the weights sum to 1. Criterion scores normalize to `[0, 1]` before anything
else happens, so a criterion worth 10 and one worth 5 contribute in proportion
rather than by accident of scale.

**A rubric version is immutable once scores exist against it.** Changing the
criteria under judges who are mid-event invalidates their work without telling
them. A new version is a new version, and runs record which one they used.

Normalization and aggregation methods are recorded on the rubric version, not on
the run, because they are part of the question being asked. Changing them
mid-judging changes the meaning of the scores already collected.

## 2. Assignment

Projects are matched to judges by strategy. All five take the same inputs — the
projects, the judges with their declared conflicts, their capacity and their
expertise, and a seed — and differ in what they optimise:

| Strategy | Optimises | Use when |
| --- | --- | --- |
| `RANDOM` | nothing in particular | Testing, and small panels |
| `BALANCED` | even spread of expertise across projects | The usual choice |
| `CONFLICT_AWARE` | conflict avoidance, balanced subject to that | The usual choice, honestly stated |
| `WORKLOAD_AWARE` | flat judge load | Uneven availability |
| `PANEL_DIVERSITY` | panel spread within a track | When track depth matters |

**A declared hard conflict is never assigned, under any strategy.** This is not a
weight in the cost function; it is a constraint. An organizer who genuinely must
proceed uses a separate, confirmed, audited override that requires a written
reason. The alternative — a conflict that is "usually" respected — is a conflict
that will eventually not be, and it will be the interesting case.

Seed-derived strategies are reproducible: the same inputs and the same seed give
the same assignment, so "why did I get this project" has an answer.

## 3. Normalization

**The problem.** Judges differ in generosity. One consistently scores 20% higher
than the panel. That is a fact about the judge, not about the projects, and left
alone it moves projects up and down the table for reasons no participant can
observe or contest.

**The response.** Normalize each judge's criterion scores against that judge's
own distribution, so generosity becomes a scale rather than a ranking.

| Method | Formula | Output | When to use it |
| --- | --- | --- | --- |
| `RAW` | score as given | `[0, 100]` | Small panels, or when you trust the panel |
| `Z_SCORE` | `(x - μ) / σ` per judge | unbounded | Large panels; keep the ordering |
| `MIN_MAX` | rescale to the judge's range | `[0, 50]` | Rarely — see below |
| `ROBUST_MAD` | `(x - median) / (1.4826 · MAD)` | `[0, 100]` | **The recommendation** |
| `RANK` | within-judge rank → percentile | `[0, 100]` | When only order is meaningful |

**`RAW` is the default.** It is the honest choice when nothing has been measured:
normalizing distorts as well as it corrects, and applying it to a panel of three
who all scored tightly does more harm than good. `ROBUST_MAD` is what to switch
to once a panel is scoring inconsistently enough to notice, and the
`normalizationComparison` endpoint shows you the effect before you commit.

**`Z_SCORE` is deliberately unbounded.** Clamping it to `[0, 100]` silently caps
how far a judge may deviate from their own mean, which is exactly the signal you
are trying to preserve. An outlier that is three sigma from a judge's norm is
information about a disagreement; flattening it hides the disagreement.

**`MIN_MAX` is the most outlier-sensitive method** and the docs say so at the
point of use. A single unusual score from a judge compresses everyone else's
range around it, so that one project ends up dominating the judge's column.

**`ROBUST_MAD`** uses the median and the median absolute deviation, scaled by
1.4826 to be comparable with a standard deviation under normality. Both are
unaffected by the outliers that make `MIN_MAX` and `Z_SCORE` fragile. It is the
default recommendation for a reason: it fixes the common case (a panel with one
harsh judge) without discarding magnitude information the way ranking does.

Every method records its own warnings, and those warnings travel into the result
run.

## 4. Aggregation

Normalized criterion scores combine by weight into a project score. Project
scores combine by the aggregation method.

The default is a **20% trimmed mean** (`MEAN` with `trim: 0.2`) over the panel,
not a plain average. A plain mean of three judges is entirely determined by the
most extreme of them: with scores of 40, 80 and 85, the mean is 68.3 — one
judge's outlier moves the result by more than the gap between the other two.
Trimming the top and bottom fifth before averaging is the cheapest honest
correction for a small panel, and it means one judge having a bad day moves a
project slightly rather than substantially.

`minimumJudges` is 3 by default. Below that, a project is flagged
`LOW_COVERAGE` rather than dropped — see below.

Alongside the score, every entry records:

- **Tie groups** — projects within a stated tolerance share a rank rather than
  being separated by float noise.
- **Rank delta** — the difference between the rank before and after
  normalization, so you can see which projects moved because of judge style
  rather than because of merit.
- **Coverage** — `judgeCount / assignedJudges`, with `LOW_COVERAGE` when a
  project was scored by fewer judges than the event asked for.

The coverage flag matters. A project judged by two of three assigned judges is
not the same claim as one judged by three, and publishing it without saying so
would be the single most contestable thing the platform could do. It publishes at
its rank, with the shortfall stated.

## 5. Pairwise comparison

Forced-choice comparisons between projects, useful where criterion scoring
produces clustering that hides an ordering.

The estimator is **ridge-regularized Bradley–Terry** solved by gradient ascent
with line search. A plain maximum-likelihood fit diverges when the comparison
graph is disconnected or has a dominant player — it sends one judge's strength
to infinity — which is not a rare case at a hackathon. The prior (strength 0.5)
keeps the estimate finite and stable, and a disconnected graph is reported
rather than silently producing a ranking from the component that happened to
have edges.

Round-robin pair generation handles an odd number of entries with a bye, so a
judge with an odd queue does not silently review one fewer project.

## 6. Diagnostics

Flags patterns an organizer should look at before publishing:

- judges scoring far above or below the panel (possible generosity, or bias)
- unusually low variance (possible anchoring, or carelessness)
- per-project score spread (possible disagreement worth surfacing)
- correlation between judge leniency and a specific project

These are **signals, not accusations**. A flagged judge may simply have reviewed
three hard projects. The diagnostic exists so the question gets asked, and the
per-project breakdown exists so it can be answered.

## 7. Snapshots and verification

A computed run records:

- `inputHash` over the exact reviews, rubric version, assignment version,
  normalization and aggregation settings
- `integrityHash` over the resulting ranking
- the full provenance, so the run can be explained in a sentence
- the per-project entries, stored with the run

Publishing freezes a run into a sequenced, append-only snapshot. Database
triggers refuse to modify or delete a published one. A correction is a new
snapshot with a `supersedes_id`, because a result that can be quietly edited is
not evidence of anything.

Verification recomputes the whole pipeline from the stored reviews and compares
it to what was published, field by field. The statuses are `MATCH`,
`MISMATCH`, and `NOT_REPRODUCIBLE`.

That is the point of the entire system. Anyone who thinks the outcome was wrong
can check whether the engine still produces it, and a mismatch is reported with
the specific field that differs rather than a generic failure.

---

## Things that are deliberately not done

- **No averaging away of disagreement.** A panel that splits is reported, not
  reconciled. Forcing consensus hides the thing participants most want to see.
- **No silent dropping.** A project below the coverage threshold publishes at
  its rank with the shortfall stated, because quietly removing it is both
  indefensible and invisible.
- **No result without a provenance record.** Every run can explain itself.
- **No "provisional" results that look final.** Either a snapshot is published,
  with a sequence number and a hash, or nothing is shown.
- **No auto-adjustment of weights or aggregation to produce a nicer ranking.**
  The method is a decision, made explicitly, recorded, and reported.
