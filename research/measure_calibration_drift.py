#!/usr/bin/env python3
"""
Calibration drift: absolute noul scores shift with the shape of the state.

What this measures
------------------
`measure_state_degradation.py` showed that the *ranking* of tool results by
JEV stays usable (AUC ~0.87-0.93) across every `fitState()` degradation
stage, but the *absolute* scores move: when the transcript has been reduced
to notes or merged into a single entry, all scores collapse into a narrow
band below 0.5 and a fixed threshold drops everything.

This script quantifies that and checks three candidate fixes:

  1. fixed threshold            (what the plugin does today)
  2. per-batch adaptive threshold   (midpoint between the two classes, or the
                                    score that maximises separation)
  3. rank-based threshold      (keep the top-k by score, k fixed)

Fix 3 is the interesting one: it never depends on the absolute calibration, so
it is immune to the drift. Its cost is that it needs an expected keep-rate.

Usage
-----
    python3 measure_calibration_drift.py \
        --endpoint http://127.0.0.1:8091/v1/systemone \
        --model StartLux-Decision-9B --api-key local --repeat 5

Only the standard library is required.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.request

GOAL = "Fix the failing test TestLoginRejectsExpiredToken in internal/auth/auth_test.go."

# (tool, input, content-head, output size, must-keep)
ITEMS: list[tuple[str, str, str, int, int]] = [
    ("bash", "ls -la", "drwxr-xr-x  25 lewisli staff 960 Sep 21 .", 8500, 0),
    ("read", "cat package.json", '{ "name": "homebrain",', 1200, 0),
    ("bash", "git log --oneline -50", "abc1234 feat: add plugin", 3000, 0),
    ("bash", "pytest -q", "200 passed in 42.13s", 9000, 1),
    ("bash", "npm outdated", "Package Current Wanted Latest", 800, 0),
    ("read", "cat internal/auth/auth_test.go", "def test_rejects_expired_token():", 5000, 1),
    ("bash", "pytest tests/auth -v", "FAILED test_token.py::test_rejects_expired_token", 4500, 1),
    ("bash", "grep -rn TODO", "core/utils/a.py:12: TODO fix", 2200, 0),
    ("read", "cat internal/auth/token.py", "class Token:", 3800, 1),
    ("bash", "ls src/", "api/ auth/ core/ ui/", 400, 0),
    ("bash", "cat Makefile", "test:\n\tpytest", 900, 0),
    ("read", "cat internal/auth/claims.py", "def validate_claims():", 2900, 1),
    ("bash", "wc -l src/*.py", "120 api.py", 600, 0),
    ("bash", "cat .env.example", "API_KEY=your_key", 500, 0),
    ("read", "cat internal/auth/expired.py", "class ExpiredError:", 3100, 1),
]

INPUT_HEAD = 60


def build_state(stage: str) -> dict:
    history = []
    for idx, (tool, inp, content, chars, _t) in enumerate(ITEMS, start=1):
        cid = f"t{idx}"
        if stage == "full":
            entry = {
                "id": cid, "tool": tool, "input": inp, "content": content,
                "result": f"ok, {chars} chars (omitted)",
            }
        elif stage == "noted":
            entry = {"id": cid, "note": f"{tool} call, ok, {chars} chars"}
        elif stage == "compacted":
            entry = {"id": cid, "text": f"{cid} {tool} command={inp[:INPUT_HEAD]} -> ok {chars}ch"}
        elif stage == "merged":
            history.append({
                "id": f"t1..t{len(ITEMS)}",
                "text": " ".join(
                    f"t{i} {ITEMS[i-1][0]} -> ok {ITEMS[i-1][3]}ch"
                    for i in range(1, len(ITEMS) + 1)
                ),
            })
            break
        else:
            raise ValueError(stage)
        history.append(entry)
    return {
        "context": "A coding assistant conversation is being compacted to free context.",
        "goal": GOAL,
        "history": history,
    }


def question(cid: str, tool: str, chars: int) -> dict:
    return {
        "type": "noul",
        "instructions": (
            f"The full output of tool call {cid} ({tool}, {chars} chars) should stay "
            "in the history verbatim: the assistant still needs its contents and "
            "re-running the tool would not do"
        ),
    }


def ask(endpoint, model, api_key, state, questions, timeout=90.0):
    body = json.dumps({"model": model, "state": state, "questions": questions}).encode()
    req = urllib.request.Request(
        endpoint, data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    t = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.load(resp)
    return (
        {k: float(v.get("noul", 0.0)) for k, v in (payload.get("answers") or {}).items()},
        (time.time() - t) * 1000,
    )


def auc(scores, labels):
    pos = sum(labels); neg = len(labels) - pos
    if pos == 0 or neg == 0:
        return float("nan")
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    ranks = [0.0] * len(scores); i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and scores[order[j + 1]] == scores[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    rsum = sum(r for r, l in zip(ranks, labels) if l == 1)
    return (rsum - pos * (pos + 1) / 2) / (pos * neg)


def best_threshold(scores, labels):
    """Threshold maximising (TPR - FPR); ties broken toward the higher one."""
    cands = sorted(set(scores))
    best = (-1.0, 0.5)
    for t in cands:
        pred = [1 if s >= t else 0 for s in scores]
        tp = sum(1 for p, l in zip(pred, labels) if p == 1 and l == 1)
        fp = sum(1 for p, l in zip(pred, labels) if p == 1 and l == 0)
        fn = sum(1 for p, l in zip(pred, labels) if p == 0 and l == 1)
        tpr = tp / max(1, tp + fn)
        fpr = fp / max(1, fp + tp)
        score = tpr - fpr
        if score >= best[0]:
            best = (score, t)
    return best[1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default="https://api.typesafe.ai/v1/systemone")
    ap.add_argument("--model", default="jev-latest")
    ap.add_argument("--api-key", default=os.environ.get("TYPESAFE_API_KEY", "local"))
    ap.add_argument("--repeat", type=int, default=5)
    args = ap.parse_args()

    labels = [t[4] for t in ITEMS]
    ids = [f"t{i}" for i in range(1, len(ITEMS) + 1)]
    n_keep = sum(labels)

    print(f"endpoint {args.endpoint}  model {args.model}  repeat {args.repeat}")
    print(f"{len(ITEMS)} items, {n_keep} must-keep\n")

    rows = []
    for stage in ("full", "noted", "compacted", "merged"):
        state = build_state(stage)
        got: dict[str, list[float]] = {k: [] for k in ids}
        for _ in range(args.repeat):
            q = {f"result_{k}": question(k, ITEMS[i][0], ITEMS[i][3]) for i, k in enumerate(ids)}
            try:
                ans, _ms = ask(args.endpoint, args.model, args.api_key, state, q)
            except Exception as exc:  # noqa: BLE001
                print(f"  {stage}: FAILED {exc}")
                break
            for k in ids:
                got[k].append(ans.get(f"result_{k}", 0.0))
        if not any(got[k] for k in ids):
            continue
        med = {k: statistics.median(got[k]) for k in ids}
        scores = [med[k] for k in ids]
        a = auc(scores, labels)

        fixed = [1 if s >= 0.5 else 0 for s in scores]
        fixed_correct = sum(1 for p, l in zip(fixed, labels) if p == l)
        fixed_kept = sum(fixed)

        bt = best_threshold(scores, labels)
        adaptive = [1 if s >= bt else 0 for s in scores]
        adaptive_correct = sum(1 for p, l in zip(adaptive, labels) if p == l)

        order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
        rank = [0] * len(scores)
        for pos, idx in enumerate(order):
            rank[idx] = 1 if pos < n_keep else 0
        rank_correct = sum(1 for p, l in zip(rank, labels) if p == l)

        rows.append({
            "stage": stage,
            "score_min": round(min(scores), 3),
            "score_max": round(max(scores), 3),
            "spread": round(max(scores) - min(scores), 3),
            "auc": round(a, 3),
            "fixed_kept": fixed_kept,
            "fixed_correct": fixed_correct,
            "best_threshold": round(bt, 3),
            "adaptive_kept": sum(adaptive),
            "adaptive_correct": adaptive_correct,
            "rank_kept": n_keep,
            "rank_correct": rank_correct,
            "total": len(ids),
        })

    print(f"{'stage':<11} {'scores':>14} {'spread':>7} {'AUC':>6} | "
          f"{'fixed@0.5':>12} | {'adaptive':>12} | {'top-k':>10}")
    for r in rows:
        print(
            f"{r['stage']:<11} "
            f"{r['score_min']:>6.3f}-{r['score_max']:<7.3f} {r['spread']:>7.3f} {r['auc']:>6.3f} | "
            f"{str(r['fixed_kept'])+'/'+str(r['fixed_correct']):>12} | "
            f"{str(r['adaptive_kept'])+'/'+str(r['adaptive_correct']):>12} | "
            f"{str(r['rank_kept'])+'/'+str(r['rank_correct']):>10}"
        )
    print()
    print("columns: kept/correct-out-of-total")
    print("  fixed@0.5  = threshold 0.5 (what the plugin does today)")
    print("  adaptive   = threshold chosen per batch to maximise separation")
    print("  top-k      = keep the k highest-scoring items, k = number of must-keep items")
    print()
    print("JSON:")
    print(json.dumps(rows, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
