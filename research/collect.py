#!/usr/bin/env python3
"""Collect the state of our submissions from the public GitHub API.

Two modes:

    collect.py                       # read the issues listing from stdin
    collect.py --one REPO NUM        # fetch one issue and its comments

Output is a JSON list, so the shell script can compare two runs.
"""

from __future__ import annotations

import json
import sys
import urllib.request

HEADERS = {"Accept": "application/vnd.github+json"}


def get_json(url: str):
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.load(resp)
    except Exception:
        return None


def summarise(item: dict) -> dict:
    user = item.get("user")
    return {
        "number": item.get("number"),
        "kind": "pr" if "pull_request" in item else "issue",
        "state": item.get("state"),
        "title": (item.get("title") or "")[:90],
        "user": user.get("login") if isinstance(user, dict) else None,
        "comments": item.get("comments", 0),
        "created": (item.get("created_at") or "")[:10],
        "updated": (item.get("updated_at") or "")[:10],
    }


def read_comments(repo: str, number: int) -> list[dict]:
    raw = get_json(f"https://api.github.com/repos/{repo}/issues/{number}/comments")
    if not isinstance(raw, list):
        return [{"user": "?", "created": "?", "body": "(could not read comments)"}]
    out = []
    for comment in raw:
        user = comment.get("user")
        out.append(
            {
                "user": user.get("login") if isinstance(user, dict) else None,
                "created": (comment.get("created_at") or "")[:10],
                "body": (comment.get("body") or "")[:800].replace("\n", " "),
            }
        )
    return out


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--one":
        repo = sys.argv[2]
        number = int(sys.argv[3])
        listing = get_json(f"https://api.github.com/repos/{repo}/issues?state=all&per_page=100")
        if not isinstance(listing, list):
            print("[]")
            return 0
        item = next((i for i in listing if i.get("number") == number), None)
        if item is None:
            print("[]")
            return 0
        entry = summarise(item)
        entry["comment_list"] = read_comments(repo, number)
        print(json.dumps([entry], ensure_ascii=False))
        return 0

    try:
        data = json.load(sys.stdin)
    except Exception:
        print("[]")
        return 0
    if not isinstance(data, list):
        print("[]")
        return 0
    print(json.dumps([summarise(item) for item in data], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
