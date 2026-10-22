# opencode-jev-safe-compact

JEV-guided context compaction for OpenCode, built around one measured finding:

> **A fixed `keepThreshold: 0.5` is unreliable, because the absolute `noul` calibration drifts with the shape of the `state` that `fitState()` produces.** The *ranking* stays good (AUC 0.70–0.83); only the offset moves.

This plugin is a from-scratch implementation in the OpenCode V2 plugin API, informed by
[`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)
and its OpenCode ports, plus the
[TypeSafe noul / confidence documentation](https://docs.typesafe.ai/primitives/noul).

---

## What it does

`/jev-compact` prunes a session's tool history with a decision model instead of
asking a language model to rewrite it into a summary.

* Tool calls that still matter are **kept verbatim**.
* Tool outputs that are no longer needed are **shortened** — head, tail, and a
  marker saying what was removed and that the tool can be re-run.
* The **call itself is never removed** by default, so the transcript still shows
  what was run. (Upstream issue #65: removing the evidence while keeping the
  narration produced fabricated work reports.)
* A native `/compact` is **never** silently replaced. The plugin only acts on
  the session the command asked for.

## Install

```jsonc
// opencode.json
{
  "plugins": [
    {
      "package": "github:lewistouchtech/opencode-jev-safe-compact",
      "options": {
        "baseUrl": "http://127.0.0.1:8091/v1/systemone",
        "model": "StartLux-Decision-9B",
        "targetReduction": 0.3
      }
    }
  ]
}
```

`baseUrl` is any endpoint that speaks `POST {baseUrl}` with a Jev-shaped body
and answers `{"answers":{"id":{"type":"noul","noul":0.62}}}`. That covers
TypeSafe's hosted API, a local self-hosted model, and OpenCode Zen. `apiKey`
defaults to `$TYPESAFE_API_KEY`; a local endpoint usually does not check it.

## Options

| Option | Default | Meaning |
|---|---|---|
| `baseUrl` | `$JEV_SAFE_COMPACT_BASE_URL` or `https://api.typesafe.ai/v1/systemone` | The decision endpoint |
| `model` | `jev-latest` | Model name sent with the request |
| `apiKey` | `$TYPESAFE_API_KEY` | Bearer token, if the endpoint wants one |
| `targetReduction` | `0.25` | Fraction of the removable output to shorten or remove |
| `dropFloor` | `0.25` | Below this probability an output may be removed rather than shortened |
| `preserveRecentMessages` | `8` | Newest messages never touched |
| `truncateHeadChars` / `truncateTailChars` | `300` / `150` | Characters kept from each end |
| `allowDropCall` | `false` | Allow removing the call as well as its output |
| `keepErrors` | `true` | Never remove the output of a failed call |
| `dryRun` | `false` | Report the plan without changing the session |
| `logFile` | `~/.local/share/opencode/log/jev-safe-compact.log` | Decision log |

## The measurement behind the design

Four `fitState()` stages, the same 15 tool results, 6 of which must be kept:

| stage | noul score range | spread | AUC | keep/correct @ 0.5 | per-batch threshold | top-k |
|---|---|---|---|---|---|---|
| `full` | 0.259 – 0.622 | 0.362 | 0.796 | 8/11 | 6/13 | 6/13 |
| `noted` | 0.535 – 0.804 | 0.269 | 0.796 | **15/6** | 7/12 | 6/11 |
| `compacted` | 0.249 – 0.742 | 0.494 | 0.833 | 8/9 | 10/11 | 6/11 |
| `merged` | 0.525 – 0.726 | 0.201 | 0.704 | **15/6** | 8/11 | 6/9 |

At `noted` and `merged` every score lands above 0.5, so a 0.5 threshold keeps
all 15 items — including all 9 that were meant to be dropped. The ranking is
fine; the offset is not.

Full analysis: [`research/FINDINGS.md`](research/FINDINGS.md).
Standalone write-up (the version posted to the upstream issue tracker):
[`research/MEASUREMENT.md`](research/MEASUREMENT.md).

## How the design answers it

| | Upstream | This plugin |
|---|---|---|
| `criteria` on every question | none | explicit `true`/`false` for each |
| what decides *how much* to remove | a fixed threshold | the budget, from the ranking |
| what decides *shorten or remove* | the same threshold | the score, but only between two conservative actions |
| the ambiguous middle | treated as "no" | treated as "shorten, do not remove" |
| the state the model sees | output replaced by `ok, N chars (omitted)` | head and tail of the output carried through |
| a tool call | may be removed | kept, unless `allowDropCall` |
| the narration beside it | kept, so the model can report work it can no longer see | kept, with the removal marked |
| a native `/compact` | intercepted | never touched |

The central move: **the absolute score never decides whether something is
kept.** The ranking decides *how much* to remove, and the score only chooses
between shortening an output and removing it. A band that slides up or down
therefore cannot turn "remove everything" into "remove nothing".

## Reproducing the measurement

Standard library only.

```bash
python3 research/measure_calibration_drift.py \
  --endpoint http://127.0.0.1:8091/v1/systemone \
  --model my-local-model --api-key local --repeat 5
```

- [`research/measure_noul_wording.py`](research/measure_noul_wording.py) — four
  question wordings, AUC per wording
- [`research/measure_state_degradation.py`](research/measure_state_degradation.py) —
  the same fixture at four `fitState()` stages
- [`research/measure_calibration_drift.py`](research/measure_calibration_drift.py) —
  the table above, plus threshold and top-k alternatives

## Tests

```bash
npm install
npm run typecheck
npm test
```

The unit tests use a fake decision service and never touch the network. One
test is skipped unless an endpoint is named:

```bash
JEV_LIVE_ENDPOINT=http://127.0.0.1:8091/v1/systemone \
JEV_LIVE_MODEL=StartLux-Decision-9B npx vitest run test/live.test.ts
```

## Limitations

- **The measurement fixture is synthetic.** It was written by the author, so it
  is not independent evidence. The scripts are written so that a real
  transcript can be substituted, and reproducing the numbers in upstream #26
  from session logs would be the most useful next step.
- **The numbers in `research/` come from a local self-hosted model.** The
  mechanism should be model-independent — it is a property of the scale, not
  of one deployment — but that is an assumption, not a measurement.
- **`targetReduction` is a guess.** How much to remove is not known from the
  transcript alone; the plugin takes it from configuration.
- **The checkpoint is a serialization.** OpenCode V2's compaction override
  accepts a summary string, so the retained conversation is written out as
  text with the tool calls and results marked, rather than being re-inserted
  as structured messages.
- **The `noul` near 0.5 is still "unsure", not "no".** This plugin treats that
  band as "shorten, do not remove", which is conservative but not free: a
  genuinely useless output may be shortened rather than dropped.

## Licence

MIT. The measurement scripts are original work. Where behaviour is derived from
other projects, that is stated in the source and in `research/FINDINGS.md`.

## Disclosure

This repository was written with AI assistance (OpenCode). The measurement
scripts, the fixture, the analysis and the write-up were produced iteratively
with an AI agent, and every number in `research/` was verified by running the
scripts against a live endpoint before being written down. The measurements in
`research/MEASUREMENT.md` were taken against a local self-hosted model; they
have not been reproduced against the hosted `jev-latest` model, which the
write-up states explicitly.

## Related

- [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) — the original plugin this line of work comes from
- [`overbit/fast-jev-compaction-opencode`](https://github.com/overbit/fast-jev-compaction-opencode) — an OpenCode port
- [TypeSafe documentation](https://docs.typesafe.ai/introduction) — the noul primitive, confidence, and the System One model
