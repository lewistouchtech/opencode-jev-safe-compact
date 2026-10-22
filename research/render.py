#!/usr/bin/env python3
"""Render a diff between two snapshots of a GitHub issues listing.

Reads the previous snapshot and the current one as JSON on stdin (a list
argument for the current one), and prints what changed.

    render.py < prev.json            # first run: list everything
    render.py < prev.json cur.json    # later runs: list only what changed
"""

from __future__ import annotations

import json
import sys


def load(stream) -> list:
    try:
        data = json.load(stream)
    except Exception:
        return []
    return data if isinstance(data, list) else []


def main() -> int:
    prev = load(sys.stdin)
    cur: list = []
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as handle:
            cur = load(handle)
    else:
        cur = prev
        prev = []

    old = {item.get("number"): item for item in prev}

    for item in cur:
        number = item.get("number")
        title = item.get("title", "")
        state = item.get("state", "")
        user = item.get("user", "")
        created = item.get("created", "")
        comments = item.get("comments", 0)
        body = item.get("body_head", "")

        before = old.get(number)
        if before is None:
            print(f"  + 新增 #{number} [{state}] {title} — {user} ({created})")
            if body:
                print(f"      {body[:150]}")
        elif (
            before.get("comments") != comments
            or before.get("state") != state
            or before.get("updated") != item.get("updated")
        ):
            print(
                f"  ~ 变更 #{number} [{before.get('state')}->{state}] "
                f"评论 {before.get('comments')}->{comments} : {title}"
            )
            if body:
                print(f"      {body[:150]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
