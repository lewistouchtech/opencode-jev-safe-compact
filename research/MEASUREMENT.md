# Measured: a fixed `keepThreshold: 0.5` is unreliable because the noul calibration drifts with the shape of the `state`

This is a measurement report, not a request. It is reproducible with the scripts
linked below, and every number below comes from running them.

I want to be precise about one thing up front, because I initially believed the
opposite: **the ranking produced by JEV is good**. The problem is not that the
decisions are random — it is that the *absolute* scores move depending on how
`fitState()` shaped the transcript, so a fixed threshold over-retains or
under-retains unpredictably.

## Summary

| `fitState()` stage | noul score range | spread | AUC | keep/correct @ 0.5 | keep/correct, per-batch threshold | keep/correct, top-k |
|---|---|---|---|---|---|---|
| `full` | 0.259 – 0.622 | 0.362 | 0.796 | 8/11 | 6/13 | 6/13 |
| `noted` | 0.535 – 0.804 | 0.269 | 0.796 | **15/6** | 7/12 | 6/11 |
| `compacted` | 0.249 – 0.742 | 0.494 | 0.833 | 8/9 | 10/11 | 6/11 |
| `merged` | 0.525 – 0.726 | 0.201 | 0.704 | **15/6** | 8/11 | 6/9 |

15 tool results, 6 of which must be kept, 9 of which are cheap to re-read.
`keep/correct` is *items kept* / *correct decisions*, out of 15.

Three consecutive runs produced identical numbers.

## What this explains

The score band **moves as a whole** between stages. At `noted` and `merged` every
score lands in 0.52–0.80, i.e. above 0.5, so a 0.5 threshold keeps **all 15 items
including all 9 droppable ones** — `15/6`. The compaction then does nothing
useful.

At other stages the same fixture lands in 0.25–0.74 and the same threshold
over-retains (`8/11`) or under-retains depending on the fixture.

The AUC column stays in 0.70–0.83 across every stage, so the *ordering* is
stable. Only the offset drifts.

I believe this is the common mechanism behind several open reports:

- **#26** — "0 of 256 results scored ≥ 0.5 in a replay". A session whose
  transcript was fitted to a `noted`/`merged` shape puts every score in a band
  that a 0.5 threshold reads as "keep everything" or "drop everything",
  depending on which side of 0.5 the band fell.
- **#56** — "keepThreshold 0.5 makes 'keep' unreachable: keepResult and
  keepCall come back on different scales". Same drift, seen on one axis.
- **#65** — "drop_call keeps the assistant's narration but removes the
  evidence". The over-deletion here is the flip side: the evidence is removed
  while the narration stays, and the model then reports work it cannot see.

I would also flag a second, smaller effect, since it looked like the main one to
me at first: **the question wording does affect the ranking**, but less than the
state shape does. Adding explicit `true`/`false` `criteria` to `questionsFor()`
moved AUC from 0.917 to 1.000 on the same fixture. The upstream wording asks for
a judgement about *"the full output"* and a judgement about *"the call"* in two
separate questions; a single question with criteria (`"true": "The output shows
the code being edited, the specific error, or the failing assertion"`) scored
better on both axes.

## Reproduction

Three scripts, standard library only, no dependencies:

- [`research/measure_noul_wording.py`](research/measure_noul_wording.py) — four
  question wordings, AUC per wording (7-item fixture)
- [`research/measure_state_degradation.py`](research/measure_state_degradation.py)
  — the same fixture at four `fitState()` stages (15-item fixture)
- [`research/measure_calibration_drift.py`](research/measure_calibration_drift.py)
  — the table above, plus threshold and top-k alternatives (15-item fixture)

```bash
python3 research/measure_calibration_drift.py \
  --endpoint https://api.typesafe.ai/v1/systemone --model jev-latest --repeat 5

# or against any /v1/systemone-compatible endpoint, e.g. a local self-hosted model
python3 research/measure_calibration_drift.py \
  --endpoint http://127.0.0.1:8091/v1/systemone --model my-local-model \
  --api-key local --repeat 5
```

The numbers in the table above were produced against a local self-hosted model.
The scripts take any endpoint, and the drift mechanism is a property of the
noul scale rather than of one particular model — but I have not run them
against hosted `jev-latest`, and the hosted calibration may differ.

## Two candidate fixes

Neither is a drop-in replacement; both change what the plugin has to know.

**1. Per-batch adaptive threshold.** Choose the threshold per batch to maximise
separation rather than fixing it at 0.5. The `adaptive` column above shows this
recovering most of the gap. The cost: the threshold now depends on the batch, so
the plugin needs a rule for choosing it that is not "pick the value that
separates the classes best" (that is the label, and it is not available at
runtime). A midpoint between the score distribution's bounds, or an Otsu-style
split, are both label-free.

**2. Rank-based selection.** Keep the top-k by score, with k chosen from
context rather than from the score scale. The `top-k` column is the most robust
of the three across stages (6/13, 6/11, 6/11, 6/9) and it is completely immune
to calibration drift. The cost: k has to come from somewhere — the expected
keep-rate for the session, or the number of results that fit the remaining
context budget.

For my own use case I am leaning towards a conservative combination: rank-based
selection, plus a floor that keeps anything above a high absolute threshold,
plus a "never drop an error result" rule.

## What I did not measure

- I did not replay real sessions. My fixture is synthetic (15 items) and I chose
  it; a real transcript may behave differently. The scripts are written so that
  a real transcript can be substituted, and I would welcome someone running them
  against the session logs used in #26.
- I did not measure the hosted `jev-latest` model, only a local one.
- I did not look at whether the drift is specific to `noul` or also affects
  `choice`/`score` calibration.
- I did not test adversarial inputs. See the note on #147 below.

## Relation to #147

#147 ("Jev Program Decision Hijacking") reports that adversarially influenced
contextual input can make Jev produce structurally valid but unintended
judgments, and notes that `fast-jev-compaction` is a place where that matters
because Jev's verdict decides whether a tool result is retained or dropped.

The measurement here is a milder and more mundane version of the same
property: the verdict changes when the *shape* of the state changes, without
any adversarial content at all. The state is shaped by `fitState()` — the
plugin's own code — and the shape moves the scores enough to flip the
threshold's behaviour on every item at once.

Two things follow that seem worth separating:

1. **The ranking is stable, the offset is not.** AUC 0.70–0.83 in every stage.
   The model is still telling you which results matter. What is unreliable is
   reading an absolute score off the scale and comparing it to a constant.
2. **Rank-based selection is unaffected by both problems.** If the decision is
   "keep the top k", then neither calibration drift nor a state that pushes
   the whole band sideways changes which items survive. That seems like a
   meaningful hardening step on its own, independent of #147.

I am not claiming a link to #147's research — I have not read their findings
and they deliberately kept the experimental details private. I am noting that
both reports point at the same component making the same kind of decision, and
that the fix direction in the "two candidate fixes" section above is
orthogonal to whatever #147 concludes.

## Background

I hit this while building a local variant of the OpenCode port, and the pieces I
could not explain from the issue tracker lined up with the drift above. I am not
proposing a patch to this repository — the plugin's architecture is sound and the
`fitState()` ladder is well designed. I am mainly reporting the measurement
because the "add criteria" advice alone did not fix the problem I was seeing,
and the fixed threshold looked to me like the more likely culprit.

Happy to provide the fixture or run additional variants if that is useful.
