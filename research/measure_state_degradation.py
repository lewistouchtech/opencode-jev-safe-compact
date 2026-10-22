#!/usr/bin/env python3
"""
Does the JEV *state* shape change the retention signal?

Hypothesis
----------
fast-jev-compaction's `fitState()` degrades the transcript into the model in
stages (see `src/state.ts`):

    full -> texts abridged -> old messages noted -> old calls compacted
         -> old calls merged

At the "old calls compacted" stage each tool call collapses to a single line:

    t3 bash command=git log --oneline -50 -> ok 3000ch

i.e. the model sees the tool name, a truncated input, and the output size --
but not what the output actually contained.

Issue #26 reported that with the upstream wording the resulting decisions were
indistinguishable from "drop everything unpinned". This script tests whether
the *stage* of the state, rather than the question wording alone, explains
that: as the state degrades, the model has less to judge on, so the ranking
signal should flatten.

For each state stage this script measures the same thing: the AUC of the
retention decision (noul >= 0.5) against ground truth, for the upstream
wording and for the upstream wording plus explicit true/false criteria.

Usage
-----
    python3 measure_state_degradation.py \
        --endpoint http://127.0.0.1:8091/v1/systemone \
        --model StartLux-Decision-9B --api-key local --repeat 3

Only the standard library is required.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

GOAL = (
    "Fix the failing test TestLoginRejectsExpiredToken in "
    "internal/auth/auth_test.go, then run the test again."
)

# tool, input, content-head, output size, ground truth (1 = must keep)
ITEMS: list[tuple[str, str, str, int, int]] = [
    ("bash", "ls -la", "drwxr-xr-x  25 lewisli  staff  960 Sep 21 .", 8500, 0),
    ("read", "cat package.json", '{ "name": "homebrain",', 1200, 0),
    ("bash", "git log --oneline -50", "abc1234 feat: add plugin", 3000, 0),
    ("bash", "pytest -q", "200 passed in 42.13s", 9000, 1),
    ("bash", "npm outdated", "Package Current Wanted Latest", 800, 0),
    ("read", "cat internal/auth/auth_test.go", "def test_rejects_expired_token():", 5000, 1),
    ("bash", "pytest tests/auth -v", "FAILED tests/auth/test_token.py::test_rejects_expired_token", 4500, 1),
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
    """Reproduce fitState() stages for a tool-call-only transcript."""
    history = []
    for idx, (tool, inp, content, chars, _truth) in enumerate(ITEMS, start=1):
        call_id = f"t{idx}"
        if stage == "full":
            entry = {
                "id": call_id,
                "tool": tool,
                "input": inp,
                "content": content,
                "result": f"ok, {chars} chars (omitted)",
            }
        elif stage == "noted":
            # old messages collapse to a one-line note
            entry = {"id": call_id, "note": f"{tool} call, ok, {chars} chars"}
        elif stage == "compacted":
            # old calls shrink to one line each
            entry = {
                "id": call_id,
                "text": f"{call_id} {tool} command={inp[:INPUT_HEAD].replace(' ', ' ')} -> ok {chars}ch",
            }
        elif stage == "merged":
            # runs of call-only messages folded into one entry
            entry = {
                "id": f"t1..t{len(ITEMS)}",
                "text": " ".join(
                    f"t{i} {ITEMS[i - 1][0]} -> ok {ITEMS[i - 1][3]}ch" for i in range(1, len(ITEMS) + 1)
                ),
            }
            history.append(entry)
            break
        else:
            raise ValueError(stage)
        history.append(entry)

    return {
        "context": (
            "A coding assistant conversation is being compacted to free context. "
            "Each question asks whether the full output of one tool call still needs "
            "to stay in the history verbatim."
        ),
        "goal": GOAL,
        "history": history,
    }


def question_upstream(call_id: str, tool: str, chars: int) -> dict:
    return {
        "type": "noul",
        "instructions": (
            f"The full output of tool call {call_id} ({tool}, {chars} chars) should stay "
            "in the history verbatim: the assistant still needs its contents and "
            "re-running the tool would not do"
        ),
    }


def question_with_criteria(call_id: str, tool: str, chars: int) -> dict:
    return {
        "type": "noul",
        "instructions": (
            f"Does the assistant still need the contents of tool call {call_id} ({tool}) "
            "to fix the failing test in internal/auth/auth_test.go?"
        ),
        "criteria": {
            "true": (
                "The output shows the code being edited, the specific error, or the "
                "failing assertion for the current task."
            ),
            "false": (
                "The output is a directory listing, a dependency manifest, a git log, "
                "or a repository survey that can be re-read cheaply."
            ),
        },
    }


def ask(endpoint, model, api_key, state, questions, timeout=90.0):
    body = json.dumps({"model": model, "state": state, "questions": questions}).encode()
    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    t = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.load(resp)
    answers = payload.get("answers") or {}
    return {k: float(v.get("noul", 0.0)) for k, v in answers.items()}, (time.time() - t) * 1000


def auc(scores, labels):
    pos = sum(labels)
    neg = len(labels) - pos
    if pos == 0 or neg == 0:
        return float("nan")
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    ranks = [0.0] * len(scores)
    i = 0
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default="https://api.typesafe.ai/v1/systemone")
    ap.add_argument("--model", default="jev-latest")
    ap.add_argument("--api-key", default=os.environ.get("TYPESAFE_API_KEY", "local"))
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--threshold", type=float, default=0.5)
    args = ap.parse_args()

    labels = [t[4] for t in ITEMS]
    ids = [f"t{i}" for i in range(1, len(ITEMS) + 1)]

    print(f"endpoint {args.endpoint}  model {args.model}  repeat {args.repeat}")
    print(f"items {len(ITEMS)} ({sum(labels)} must keep / {len(labels) - sum(labels)} droppable)")
    print()

    report = {}
    for stage in ("full", "noted", "compacted", "merged"):
        for variant, builder in (
            ("upstream", question_upstream),
            ("with criteria", question_with_criteria),
        ):
            state = build_state(stage)
            got: dict[str, list[float]] = {k: [] for k in ids}
            lat: list[float] = []
            for _ in range(args.repeat):
                questions = {
                    f"result_{k}": builder(k, ITEMS[i][0], ITEMS[i][3])
                    for i, k in enumerate(ids)
                }
                try:
                    ans, ms = ask(args.endpoint, args.model, args.api_key, state, questions)
                except Exception as exc:  # noqa: BLE001
                    print(f"  {stage}/{variant}: FAILED {type(exc).__name__}: {exc}")
                    break
                lat.append(ms)
                for k in ids:
                    got[k].append(ans.get(f"result_{k}", 0.0))
            if not any(got[k] for k in ids):
                continue
            med = {k: statistics.median(got[k]) for k in ids}
            scores = [med[k] for k in ids]
            a = auc(scores, labels)
            kept = sum(1 for k in ids if med[k] >= args.threshold)
            correct = sum(
                1 for i, k in enumerate(ids)
                if (med[k] >= args.threshold) == bool(labels[i])
            )
            key = f"{stage} / {variant}"
            report[key] = {
                "auc": round(a, 3),
                "kept": kept,
                "correct": correct,
                "total": len(ids),
                "median_latency_ms": round(statistics.median(lat)) if lat else None,
                "scores": {k: round(med[k], 4) for k in ids},
            }
            print(
                f"{key:<28} AUC {a:.3f}   kept {kept}/{len(ids)}   "
                f"correct {correct}/{len(ids)}"
            )
        print()

    print("summary (AUC by state stage)")
    print(f"  {'stage':<12} {'upstream':>10} {'+criteria':>12}")
    for stage in ("full", "noted", "compacted", "merged"):
        u = report.get(f"{stage} / upstream", {}).get("auc")
        c = report.get(f"{stage} / with criteria", {}).get("auc")
        print(f"  {stage:<12} {u if u is not None else '-':>10} {c if c is not None else '-':>12}")
    print()
    print("JSON:")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
