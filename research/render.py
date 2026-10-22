#!/usr/bin/env python3
"""Render a diff between two snapshots of our submissions.

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
    # stdin carries the current snapshot; argv[1] is the previous one.
    cur = load(sys.stdin)
    prev: list = []
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as handle:
            prev = load(handle)

    old = {item.get("number"): item for item in prev}

    for item in cur:
        number = item.get("number")
        title = item.get("title", "")
        state = item.get("state", "")
        kind = item.get("kind", "issue")
        updated = item.get("updated", "")
        comments = item.get("comment_list") or []
        before = old.get(number)

        if before is None:
            print(f"  + 我们发的 #{number} ({kind}) [{state}] {title}")
        else:
            changed = False
            if before.get("state") != state:
                print(f"  ~ #{number} 状态 {before.get('state')} -> {state}")
                changed = True
            old_comments = before.get("comment_list") or []
            if len(old_comments) != len(comments):
                changed = True
            if changed:
                print(f"  ~ #{number} [{state}] {title}")

        if not comments:
            if before is None:
                print("      (还没有评论)")
            continue

        # Only the comments that are new since the previous run.
        shown = comments
        if before is not None:
            old_comments = before.get("comment_list") or []
            if len(old_comments) < len(comments):
                shown = comments[len(old_comments):]
            elif len(old_comments) == len(comments):
                # Same count, but they may have been edited.
                if old_comments != comments:
                    shown = comments
        for comment in shown:
            print(f"      💬 {comment.get('user')} @{comment.get('created')}")
            body = (comment.get("body") or "").strip()
            if body:
                print(f"         {body[:500]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
