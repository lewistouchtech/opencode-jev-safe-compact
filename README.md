# opencode-jev-safe-compact

JEV-guided context compaction for OpenCode, built around one measured finding:

> **A fixed `keepThreshold: 0.5` is unreliable, because the absolute `noul` calibration drifts with the shape of the `state` that `fitState()` produces.** The *ranking* stays good (AUC 0.70–0.83); only the offset moves.

This plugin is a from-scratch implementation in the OpenCode plugin API, informed by
[`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)
and its OpenCode ports, plus the
[TypeSafe noul / confidence documentation](https://docs.typesafe.ai/primitives/noul).

---

## Status

**Research phase.** The measurement scripts in `research/` are complete and
reproducible. The plugin itself (`src/`) is not implemented yet — see
[Roadmap](#roadmap).

The reason for publishing the research first is that the headline finding
contradicts the most common advice on the issue tracker ("add `criteria`"), and
the measurement should be reviewed before anyone builds on it.

## The finding

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

## Reproducing

Standard library only.

```bash
# any /v1/systemone-compatible endpoint
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

## Design principles for the plugin

Drawn from the TypeSafe docs and the measurement above.

1. **Never use a fixed absolute threshold on `noul`.** Rank-based selection, or a
   per-batch threshold, both of which survive calibration drift.
2. **A `noul` near 0.5 means "unsure", not "no".** The docs are explicit that the
   single probability already describes the whole distribution, and that a value
   near 0.5 is a tie. Treat the middle band as *keep* — the cost of keeping a
   stale result is far lower than the cost of deleting the evidence for a step
   the model still needs.
3. **Every question gets explicit `true`/`false` criteria.** The docs recommend
   this whenever the yes/no boundary is subtle, and the measurement shows it
   helps the ranking too.
4. **One narrow question per `noul`.** Do not ask "is this call and its output
   both still needed" — that is two questions, and the combined answer means
   less.
5. **Truncate before deleting.** A truncated result with a head, a tail, and a
   re-run hint keeps the evidence trail; a deleted result leaves the model's
   narration standing alone, which is how a model ends up reporting work that
   never happened.
6. **Fail open.** If the decision service is unavailable, times out, or the
   reduction is not worth it, do nothing and let OpenCode fall back to its
   native compaction.
7. **Do not hook the generic `compaction` event.** Provide an explicit command
   instead, so a native `/compact` is never silently replaced.

## Roadmap

- [x] Measurement scripts, reproducible, standard library only
- [x] Finding written up in `research/FINDINGS.md`
- [ ] Plugin: local `/v1/systemone` client (any OpenAI-compatible endpoint)
- [ ] Plugin: state construction with content heads/tails
- [ ] Plugin: criteria templates + rank-based selection
- [ ] Plugin: `/jev-compact` command, dry-run by default
- [ ] Tests with a fake decision service (no network)

## Licence

MIT. The measurement scripts are original work. Where behaviour is derived from
other projects, that is stated in the source and in `research/FINDINGS.md`.

## Related

- [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) — the original plugin this line of work comes from
- [`overbit/fast-jev-compaction-opencode`](https://github.com/overbit/fast-jev-compaction-opencode) — an OpenCode port
- [TypeSafe documentation](https://docs.typesafe.ai/introduction) — the noul primitive, confidence, and the System One model
