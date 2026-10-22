#!/usr/bin/env python3
"""
Measure whether Noul `criteria` change the ranking signal for tool-result retention.

Context
-------
fast-jev-compaction (and its OpenCode ports) ask JEV one `noul` question per
tool call / tool result, with **no `criteria`**:

    instructions: "The full output of tool call t1 (read, 8421 chars) should
                   stay in the history verbatim: the assistant still needs its
                   contents and re-running the tool would not do"

Issue #26 reported that with this wording the decisions were indistinguishable
from "drop everything that is not pinned". This script reproduces that claim
and measures the effect of adding explicit true/false `criteria`.

It also measures the effect of three more wordings, so the result is a
comparison rather than a single anecdote:

  V1  upstream wording, no criteria
  V2  upstream wording + criteria
  V3  question phrased as a question + criteria
  V4  criteria that name the cheap-to-reread categories explicitly

Metric
------
AUC over the retention decision (noul >= 0.5) against a per-item ground truth.
AUC 0.5 = no better than chance, 1.0 = perfect ranking. Ranking quality is what
matters for compaction: a threshold can be moved, but a flat score distribution
cannot be fixed by moving it.

Usage
-----
    # hosted JEV (needs TYPESAFE_API_KEY)
    python3 measure_noul_wording.py --endpoint https://api.typesafe.ai/v1/systemone \
        --model jev-latest --api-key "$TYPESAFE_API_KEY"

    # any OpenAI-compatible /v1/systemone endpoint (local, self-hosted, ...)
    python3 measure_noul_wording.py --endpoint http://127.0.0.1:8091/v1/systemone \
        --model StartLux-Decision-9B --api-key local

    # repeat each wording N times and take the median (default 3)
    python3 measure_noul_wording.py --endpoint ... --repeat 5

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

# --------------------------------------------------------------------------
# Fixture
#
# A realistic coding-agent transcript fragment: the agent is fixing one failing
# test. Five tool results are cheap to re-read (directory listing, dependency
# manifest, git log, dependency check, a passing full-suite run) and two carry
# the evidence needed to make the fix (the source file, the failing test output).
#
# ground_truth: 1 = must be kept, 0 = may be dropped
# --------------------------------------------------------------------------

GOAL = (
    "Fix the failing test TestLoginRejectsExpiredToken in "
    "internal/auth/auth_test.go, then run the test again."
)

RESULTS: dict[str, dict[str, object]] = {
    "t1": {
        "tool": "bash",
        "input": "ls -la",
        "content": "drwxr-xr-x  25 lewisli  staff  960 Sep 21 .",
        "chars": 8500,
        "ground_truth": 0,
    },
    "t2": {
        "tool": "read",
        "input": "cat package.json",
        "content": '{ "name": "homebrain", "dependencies": {',
        "chars": 1200,
        "ground_truth": 0,
    },
    "t3": {
        "tool": "bash",
        "input": "git log --oneline -50",
        "content": "abc1234 feat: add plugin",
        "chars": 3000,
        "ground_truth": 0,
    },
    "t4": {
        "tool": "bash",
        "input": "pytest -q",
        "content": "200 passed in 42.13s",
        "chars": 9000,
        "ground_truth": 1,
    },
    "t5": {
        "tool": "bash",
        "input": "npm outdated",
        "content": "Package Current Wanted Latest",
        "chars": 800,
        "ground_truth": 0,
    },
    "t6": {
        "tool": "read",
        "input": "cat internal/auth/auth_test.go",
        "content": "def test_rejects_expired_token():\n    with pytest.raises(ExpiredError):",
        "chars": 5000,
        "ground_truth": 1,
    },
    "t7": {
        "tool": "bash",
        "input": "pytest tests/auth -v",
        "content": "FAILED tests/auth/test_token.py::test_rejects_expired_token",
        "chars": 4500,
        "ground_truth": 1,
    },
}


# --------------------------------------------------------------------------
# Wordings
# --------------------------------------------------------------------------

def wording_v1(call_id: str, tool: str, chars: int) -> dict:
    """Upstream wording: instructions only, no criteria."""
    return {
        "type": "noul",
        "instructions": (
            f"The full output of tool call {call_id} ({tool}, {chars} chars) should stay "
            "in the history verbatim: the assistant still needs its contents and "
            "re-running the tool would not do"
        ),
    }


def wording_v2(call_id: str, tool: str, chars: int) -> dict:
    """Upstream instructions + explicit true/false criteria."""
    return {
        "type": "noul",
        "instructions": (
            f"Does the assistant still need the contents of tool call {call_id} ({tool}) "
            f"to {GOAL.split(',')[0].lower()}?"
        ),
        "criteria": {
            "true": (
                "The output contains the source code, error details, or test results "
                "needed to make the change."
            ),
            "false": (
                "The output is generic repo state, dependency listings, or git history "
                "that can be re-read cheaply."
            ),
        },
    }


def wording_v3(call_id: str, tool: str, chars: int) -> dict:
    """Statement form + criteria, mirroring the upstream 'call' question."""
    return {
        "type": "noul",
        "instructions": (
            f"Tool call {call_id} ({tool}) should stay in the history: knowing this call "
            "was made, with its input, still matters for what the assistant does next"
        ),
        "criteria": {
            "true": (
                "The assistant's next step depends on this call or its output, and "
                "re-running the tool would not recover the same context cheaply."
            ),
            "false": (
                "The call is a generic repository survey, dependency check, or version "
                "lookup whose information the assistant already has or can cheaply re-read."
            ),
        },
    }


def wording_v4(call_id: str, tool: str, chars: int) -> dict:
    """Criteria that name the cheap categories by example, plus a content note."""
    return {
        "type": "noul",
        "instructions": (
            f"Is the full output of tool call {call_id} ({tool}) still needed to "
            f"{GOAL.split(',')[0].lower()}?"
        ),
        "criteria": {
            "true": (
                "The output shows the code being edited, the specific error, or the "
                "failing assertion for the current task."
            ),
            "false": (
                "The output is a directory listing, a dependency manifest, a git log, "
                "or an unrelated passing test run."
            ),
        },
    }


WORDINGS = {
    "V1 upstream (no criteria)": wording_v1,
    "V2 upstream + criteria": wording_v2,
    "V3 call-form + criteria": wording_v3,
    "V4 example-named criteria": wording_v4,
}


# --------------------------------------------------------------------------
# Client
# --------------------------------------------------------------------------

def ask(
    endpoint: str,
    model: str,
    api_key: str,
    state: dict,
    questions: dict,
    timeout: float = 60.0,
) -> tuple[dict, float]:
    body = json.dumps(
        {"model": model, "state": state, "questions": questions}
    ).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    start = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.load(resp)
    elapsed = (time.time() - start) * 1000
    answers = payload.get("answers") or {}
    return {k: float(v.get("noul", 0.0)) for k, v in answers.items()}, elapsed


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------

def auc(scores: list[float], labels: list[int]) -> float:
    """Mann-Whitney U form. Returns 0.5 for a degenerate label set."""
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
        avg_rank = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg_rank
        i = j + 1
    rank_sum_pos = sum(r for r, l in zip(ranks, labels) if l == 1)
    return (rank_sum_pos - pos * (pos + 1) / 2) / (pos * neg)


def build_state(show_content: bool) -> dict:
    memories = []
    for call_id, item in RESULTS.items():
        entry: dict[str, object] = {
            "id": call_id,
            "tool": item["tool"],
            "input": item["input"],
        }
        if show_content:
            entry["content"] = item["content"]
        else:
            entry["result"] = f"ok, {item['chars']} chars (omitted)"
        memories.append(entry)
    return {
        "context": (
            "A coding assistant conversation is being compacted to free context. "
            "Each question asks whether the full output of one tool call still needs "
            "to stay in the history verbatim."
        ),
        "goal": GOAL,
        "history": memories,
    }


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--endpoint", default="https://api.typesafe.ai/v1/systemone")
    ap.add_argument("--model", default="jev-latest")
    ap.add_argument("--api-key", default=os.environ.get("TYPESAFE_API_KEY", "local"))
    ap.add_argument("--repeat", type=int, default=3, help="rounds per wording")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    args = ap.parse_args()

    labels = [int(RESULTS[k]["ground_truth"]) for k in RESULTS]
    ids = list(RESULTS)

    print(f"endpoint : {args.endpoint}")
    print(f"model    : {args.model}")
    print(f"repeat   : {args.repeat} round(s), median score per item")
    print(f"threshold: {args.threshold}")
    print()

    report: dict[str, dict] = {}

    for label, builder in WORDINGS.items():
        # V1..V3 hide the result content (upstream behaviour); V4 shows a
        # content snippet, mirroring the "keep head/tail" proposal in #26.
        show_content = label.startswith("V4")
        state = build_state(show_content)

        collected: dict[str, list[float]] = {k: [] for k in ids}
        latencies: list[float] = []
        errors: list[str] = []

        for _ in range(args.repeat):
            questions = {
                f"result_{k}": builder(
                    k, str(RESULTS[k]["tool"]), int(RESULTS[k]["chars"])
                )
                for k in ids
            }
            try:
                answers, ms = ask(args.endpoint, args.model, args.api_key, state, questions)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                errors.append(f"{type(exc).__name__}: {exc}")
                continue
            latencies.append(ms)
            for k in ids:
                collected[k].append(answers.get(f"result_{k}", 0.0))

        if errors and not collected[k]:
            print(f"{label}: FAILED - {errors[0]}")
            continue

        medians = {k: statistics.median(collected[k]) for k in ids}
        scores = [medians[k] for k in ids]
        a = auc(scores, labels)
        kept = [k for k in ids if medians[k] >= args.threshold]
        correct = sum(
            1 for k in ids if (medians[k] >= args.threshold) == bool(labels[ids.index(k)])
        )
        report[label] = {
            "auc": a,
            "kept_at_threshold": len(kept),
            "kept_ids": kept,
            "decision_accuracy": correct,
            "total": len(ids),
            "median_latency_ms": statistics.median(latencies) if latencies else None,
            "scores": {k: round(medians[k], 4) for k in ids},
        }

        print(f"{label}")
        print(f"  AUC {a:.3f}   kept {len(kept)}/{len(ids)}   decisions correct {correct}/{len(ids)}")
        if latencies:
            print(f"  median latency {statistics.median(latencies):.0f} ms")
        for k in ids:
            mark = "keep" if medians[k] >= args.threshold else "drop"
            want = "keep" if labels[ids.index(k)] else "drop"
            flag = " " if mark == want else "  <- differs from ground truth"
            print(f"    {k}  noul={medians[k]:.3f}  {mark:4s} (truth: {want}){flag}")
        if errors:
            print(f"  errors: {errors[0]}")
        print()

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("summary")
        print(f"  {'wording':<28} {'AUC':>6}  {'kept':>6}  {'correct':>8}")
        for label, data in report.items():
            print(
                f"  {label:<28} {data['auc']:>6.3f}  "
                f"{data['kept_at_threshold']:>2}/{data['total']:<3}  "
                f"{data['decision_accuracy']:>3}/{data['total']:<4}"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
