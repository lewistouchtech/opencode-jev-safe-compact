#!/usr/bin/env bash
# Track replies to the three submissions.
#
# Usage:
#   ./research/check-replies.sh            # one-shot report
#   ./research/check-replies.sh --watch    # poll every 10 minutes
#
# Read-only: uses the public GitHub API. Works with a token that only has
# read access, and works without a token at all.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="$HERE/render.py"

STATE_DIR="${TMPDIR:-/tmp}/jev-safe-compact-replies"
mkdir -p "$STATE_DIR"

# repo:number -> our own submission there.
TARGETS=(
  "tamaratran/fast-jev-compaction:154"
  "overbit/fast-jev-compaction-opencode:3"
  "yibie/awesome-jev:384"
)

fetch() {
  # $1 = owner/name
  local repo="$1"
  curl -s -m 20 -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${repo}/issues?state=all&per_page=100" \
    | python3 "$HERE/collect.py"
}

# $1 = owner/name, $2 = issue number
mine() {
  python3 "$HERE/collect.py" --one "$1" "$2"
}

report() {
  local changed=0
  for target in "${TARGETS[@]}"; do
    local repo="${target%%:*}"
    local number="${target##*:}"
    local f="$STATE_DIR/$(echo "$repo" | tr '/' '_')_$number.json"
    local mine_json
    mine_json=$(mine "$repo" "$number")

    local count
    count=$(printf '%s' "$mine_json" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)

    if [ "$count" = "0" ]; then
      echo "— $repo#$number: 找不到该条目"
      continue
    fi

    if [ ! -f "$f" ]; then
      echo "$mine_json" > "$f"
      echo "首次记录：$repo#$number"
      printf '%s' "$mine_json" | python3 "$RENDER"
      continue
    fi

    # Compare the parsed content, not the bytes: the shell and the file can
    # differ by a trailing newline.
    if printf '%s' "$mine_json" | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin),sort_keys=True))' > "$f.new" \
       && python3 -c 'import sys,json;print(json.dumps(json.load(open(sys.argv[1])),sort_keys=True))' "$f" > "$f.old" \
       && cmp -s "$f.new" "$f.old"; then
      rm -f "$f.new" "$f.old"
      echo "— $repo#$number: 无新回复"
      continue
    fi
    rm -f "$f.new" "$f.old"

    changed=1
    echo "=== $repo#$number: 有更新 ==="
    python3 "$RENDER" "$f" < <(printf '%s' "$mine_json")
    echo "$mine_json" > "$f"
  done

  if [ "$changed" = 1 ]; then
    echo
    echo ">>> 需要人工阅读的链接："
    echo "    上游母仓   https://github.com/tamaratran/fast-jev-compaction/issues/154"
    echo "    移植版     https://github.com/overbit/fast-jev-compaction-opencode/issues/3"
    echo "    收录 PR    https://github.com/yibie/awesome-jev/pull/384"
  fi
}

if [ "${1:-}" = "--watch" ]; then
  while true; do
    echo "=== $(date '+%F %T') ==="
    report
    sleep 600
  done
else
  report
fi
