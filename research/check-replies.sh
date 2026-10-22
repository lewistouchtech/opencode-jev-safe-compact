#!/usr/bin/env bash
# Check for replies to the three submissions and print what changed.
#
# Usage:
#   ./research/check-replies.sh              # one-shot report
#   ./research/check-replies.sh --watch      # poll every 5 minutes
#
# Read-only: uses the public GitHub API, so it works with a token that only
# has read access, and it works without a token at all.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="$HERE/render.py"

OWNER=lewistouchtech
REPO=opencode-jev-safe-compact

# Repositories where a reply to our submission would show up.
# GitHub serves pull requests through the /issues endpoint too, so one call
# per repository covers both issues and pull requests.
TARGETS=(
  "tamaratran/fast-jev-compaction"
  "overbit/fast-jev-compaction-opencode"
  "yibie/awesome-jev"
)

STATE_DIR="${TMPDIR:-/tmp}/jev-safe-compact-replies"
mkdir -p "$STATE_DIR"

fetch() {
  # $1 = owner/name
  local repo="$1"
  curl -s -m 20 -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${repo}/issues?state=all&per_page=50" \
    | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    print("[]")
    sys.exit(0)
if not isinstance(data, list):
    print("[]")
    sys.exit(0)
out = []
for it in data:
    body = (it.get("body") or "")[:200].replace("\n", " ")
    out.append({
        "number": it.get("number"),
        "state": it.get("state"),
        "title": (it.get("title") or "")[:90],
        "user": (it.get("user") or {}).get("login"),
        "comments": it.get("comments", 0),
        "created": (it.get("created_at") or "")[:10],
        "updated": (it.get("updated_at") or "")[:10],
        "body_head": body,
    })
print(json.dumps(out, ensure_ascii=False))
'
}

report() {
  local changed=0
  for repo in "${TARGETS[@]}"; do
    local f="$STATE_DIR/$(echo "$repo" | tr '/' '_').json"
    local cur
    cur=$(fetch "$repo")
    if [ ! -f "$f" ]; then
      echo "$cur" > "$f"
      echo "首次记录：$repo"
      printf '%s' "$cur" | python3 "$RENDER"
      continue
    fi
    if cmp -s "$f" <(printf '%s' "$cur"); then
      echo "无变化：$repo"
      continue
    fi
    changed=1
    echo "有更新：$repo"
    python3 "$RENDER" "$f" < <(printf '%s' "$cur")
    echo "$cur" > "$f"
  done
  if [ "$changed" = 1 ]; then
    echo
    echo ">>> 有新回复，需要人工阅读："
    echo "    https://github.com/${OWNER}/${REPO}/issues"
  fi
}

if [ "${1:-}" = "--watch" ]; then
  while true; do
    echo "=== $(date '+%F %T') ==="
    report
    sleep 300
  done
else
  report
fi
