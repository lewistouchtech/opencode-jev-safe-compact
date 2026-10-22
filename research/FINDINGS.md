# Findings: `noul` calibration drifts with the shape of the `state`

## The short version

A `noul` answer is a probability, and the plugin in this lineage compares it to a
fixed `keepThreshold: 0.5`. The measurement below shows that the **absolute**
value of that probability moves when `fitState()` reshapes the transcript, while
the **ranking** it induces stays usable.

The result: a fixed threshold over-retains or under-retains depending on the
shape of the state it happened to be given, with no signal to the caller that
anything went wrong.

## Setup

A synthetic coding-agent transcript. The agent is fixing one failing test.

15 tool results, of which:

- **6 must be kept** — the source file being edited, the failing test output, the
  module the fix lives in, and three more that carry the evidence for the change
- **9 are droppable** — directory listings, a dependency manifest, a git log, a
  dependency check, a passing full-suite run, a `grep TODO`, and similar

The same 15 items are presented to the decision service at four different
`fitState()` stages, mirroring the ladder in `src/state.ts` of
[`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction):

| stage | what the model sees for a tool call |
|---|---|
| `full` | structured: id, tool, input, content head, `ok, N chars (omitted)` |
| `noted` | one-line note: `bash call, ok, 8500 chars` |
| `compacted` | one line: `t1 bash command=ls -la -> ok 8500ch` |
| `merged` | all calls folded into a single entry |

Question wording is the upstream one from `questionsFor()`:

> The full output of tool call t1 (read, 8421 chars) should stay in the history
> verbatim: the assistant still needs its contents and re-running the tool would
> not do

Scores are the median of 5 rounds per item.

## Result

```
stage               scores  spread    AUC |    fixed@0.5 |     adaptive |      top-k
full         0.259-0.622     0.362  0.796 |         8/11 |         6/13 |       6/13
noted        0.535-0.804     0.269  0.796 |         15/6 |         7/12 |       6/11
compacted    0.249-0.742     0.494  0.833 |          8/9 |        10/11 |       6/11
merged       0.525-0.726     0.201  0.704 |         15/6 |         8/11 |        6/9
```

`keep/correct` is *items kept* / *correct decisions*, out of 15.

Three consecutive runs produced identical numbers.

### Reading the table

**AUC is stable (0.70–0.83).** The model is ordering the results sensibly in
every stage. The information needed to rank "this is the failing test output"
against "this is a directory listing" survives the degradation.

**The score band moves.** At `full` the scores span 0.259–0.622 and straddle
0.5, so a 0.5 threshold separates them. At `noted` the same fixture spans
0.535–0.804 — entirely above 0.5 — and at `merged` 0.525–0.726. In both cases
the threshold keeps **all 15 items**, all 9 droppable ones included. The
compaction then achieves nothing.

At `compacted` the band is widest (0.494) and the fixed threshold does best
(8/9).

**The two fixes behave differently.**

- *Per-batch threshold* — pick the threshold per batch to maximise separation.
  Recovers most of the gap (13, 12, 11, 11 correct) but needs a label-free
  rule for choosing it.
- *Top-k* — keep the k highest-scoring items, k fixed. Most robust across
  stages and completely immune to calibration drift, since it never reads the
  absolute scale. But k has to come from context, not from the scores.

## What this probably explains on the tracker

These are my hypotheses, not verified claims about those reports — I did not
replay the sessions behind them.

- **#26** ("0 of 256 results scored ≥ 0.5 in a replay") — a transcript fitted to
  a shape whose score band sits below 0.5 would produce exactly that, while
  still ordering the items correctly.
- **#56** ("keepThreshold 0.5 makes 'keep' unreachable: keepResult and keepCall
  come back on different scales") — the same drift observed on one axis.
- **#65** ("drop_call keeps the assistant's narration but removes the evidence")
  — the flip side. If the evidence is removed while the narration survives, the
  model is left describing work whose result it can no longer see, and it
  starts filling the gap. Over-retention and over-deletion produce the same
  observable symptom from the model's side.

## A second, smaller effect: the question wording

I initially assumed the missing `criteria` was the main problem, because
`questionsFor()` sends `instructions` only. Measuring it on a smaller fixture
(7 results, 2 of which must be kept — `research/measure_noul_wording.py`):

| wording | AUC | decisions correct |
|---|---|---|
| V1 upstream, no criteria | 0.917 | 5/7 |
| V2 upstream + explicit `true`/`false` criteria | 1.000 | 6/7 |
| V3 call-form + criteria | 0.917 | 6/7 |
| V4 criteria naming the cheap categories | 0.833 | 6/7 |

So criteria does improve the ranking — but the state-shape drift moves the
scores by more than the wording does. Advice to "add criteria" is right and
worthwhile; it is not the whole fix.

Note the two scripts use different fixtures (7 items vs 15 items), so their
AUC numbers are not comparable with each other; compare within a table, not
across tables.

One item (`t4`, a `pytest -q` run that reported "200 passed") is dropped by
every wording. The goal in the fixture is "fix the failing test …", and against
that goal a *passing* full-suite run genuinely looks irrelevant. The model is
reasoning correctly; the goal is simply narrow. Widening the goal moved the
score from 0.339 to 0.659–0.753. This is a property of goal-anchored
judgements rather than a defect, and it is why the plugin should be reluctant
to delete on the strength of a single goal-anchored question.

## What was not measured

- Real sessions. The fixture is synthetic and I chose it. The scripts are
  written so a real transcript can be substituted, and reproducing the numbers
  in #26 from session logs would be the most useful next step.
- The hosted `jev-latest` model. The numbers above come from a local
  self-hosted model speaking the same `/v1/systemone` protocol. The mechanism
  should be model-independent — it is a property of the scale, not of one
  deployment — but that is an assumption, not a measurement.
- Whether `choice` and `score` drift the same way.
- How the drift behaves over many rounds of repeated compaction on one session.

## Implications for a plugin

1. Do not compare `noul` to a fixed absolute threshold. Rank-based selection is
   immune to the drift; a per-batch threshold needs a label-free rule.
2. Treat the middle of the scale as *unsure*, and keep. The TypeSafe docs are
   explicit that a `noul` near 0.5 is a tie, not a "no".
3. Truncate before deleting. A truncated result with a head, a tail and a
   re-run hint preserves the evidence trail; a deleted result leaves the
   narration standing alone.
4. Keep error results regardless of score.
5. Fail open. If the service is unavailable, times out, or the reduction is not
   worth it, decline and let OpenCode fall back.

## Provenance

The scripts in this directory are original. The `fitState()` stage ladder and
the upstream question wording are reimplemented from
[`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)
(MIT) for the purpose of measurement; no code was copied from it.
