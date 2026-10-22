Adds one entry to `categories/agent-decisions.md`.

## What it is

A measurement study for JEV-guided context compaction in OpenCode, with three
reproducible scripts that make real `Noul` calls against any
`/v1/systemone`-compatible endpoint.

## The finding

A `Noul` retention decision keeps its **ranking** (AUC 0.70–0.83) across every
`fitState()` degradation stage, but its **absolute score drifts** with the shape
of the state. A fixed `keepThreshold: 0.5` therefore over-retains or
under-retains depending on the shape the transcript happened to be fitted into:

| stage | score range | AUC | keep/correct @ 0.5 | per-batch threshold | top-k |
|---|---|---|---|---|---|
| `full` | 0.259 – 0.622 | 0.796 | 8/11 | 6/13 | 6/13 |
| `noted` | 0.535 – 0.804 | 0.796 | **15/6** | 7/12 | 6/11 |
| `compacted` | 0.249 – 0.742 | 0.833 | 8/9 | 10/11 | 6/11 |
| `merged` | 0.525 – 0.726 | 0.704 | **15/6** | 8/11 | 6/9 |

15 tool results, 6 of which must be kept. Three consecutive runs produced
identical numbers.

This suggests a common mechanism behind several open reports on
`fast-jev-compaction` (#26, #56, #65) — the reports themselves are not
referenced here because they are in a different repository, and the entry
describes only what this repository measured.

## Depth

- The scripts perform the decision they claim: a real `Noul` request carrying
  typed questions, and a parsed answer read back.
- They are runnable checks — standard library only, no dependencies:
  `python3 research/measure_calibration_drift.py --endpoint <url> --model <name>`
- The numbers in the entry trace to `research/FINDINGS.md` and
  `research/MEASUREMENT.md` in the linked repository, and can be regenerated
  from the scripts.

## Scope

The repository is currently at the research stage: the plugin itself is not
implemented, and the entry says so ("measurement study"). The scripts are
described as what they are — measurement code — rather than as a shipped
plugin.

## AI assistance

Disclosed as required by the contributing guide. The scripts, fixture, analysis
and write-up were produced with AI assistance, and every published number was
verified by running the scripts against a live endpoint before being written
down. The measurements were taken against a local self-hosted model; the
write-up states that they have not been reproduced against the hosted
`jev-latest` model.
