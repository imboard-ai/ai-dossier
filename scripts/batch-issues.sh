#!/usr/bin/env bash
#
# batch-issues.sh — Run full-cycle-issue on multiple GitHub issues in parallel
#
# Usage:
#   ./scripts/batch-issues.sh 102 103 104 105
#   ./scripts/batch-issues.sh 102..110              # all open issues in range 102-110
#   ./scripts/batch-issues.sh 50..60 102 103        # mix ranges and individual issues
#   ./scripts/batch-issues.sh --label epic/v2        # sequential epic: all open issues with label
#   ./scripts/batch-issues.sh $(gh issue list --label "agent-friendly" --json number --jq '.[].number')
#
# Each issue gets its own Claude Code agent in a separate process.
# Logs go to /tmp/batch-issues/<issue-number>.log
#
# Options:
#   --max-parallel N   Max concurrent agents (default: 3)
#   --label LABEL      Fetch all open issues with this label and run sequentially (epic mode)
#   --dry-run          Print commands without executing
#   --model MODEL      Model to use (default: opus)

set -uo pipefail

# cd to repo root so agents start in the right place
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

MAX_PARALLEL=3
DRY_RUN=false
MODEL="opus"
LABEL=""
ISSUES=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --max-parallel) MAX_PARALLEL="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --model)        MODEL="$2"; shift 2 ;;
    --label)        LABEL="$2"; shift 2 ;;
    *)
      if [[ "$1" =~ ^([0-9]+)\.\.([0-9]+)$ ]]; then
        range_start="${BASH_REMATCH[1]}"
        range_end="${BASH_REMATCH[2]}"
        if [[ "$range_start" -gt "$range_end" ]]; then
          echo "Error: invalid range ${range_start}..${range_end} (start > end)" >&2
          exit 1
        fi
        echo "Fetching open issues in range ${range_start}..${range_end}..."
        # Fetch all open issues and filter to the range
        range_issues=$(gh issue list --state open --limit 500 --json number --jq \
          "[.[].number | select(. >= ${range_start} and . <= ${range_end})] | sort | .[]")
        if [[ -z "$range_issues" ]]; then
          echo "  No open issues found in range ${range_start}..${range_end}"
        else
          while IFS= read -r num; do
            ISSUES+=("$num")
            echo "  Found open issue #${num}"
          done <<< "$range_issues"
        fi
      else
        ISSUES+=("$1")
      fi
      shift
      ;;
  esac
done

# ── Label mode: fetch open issues by label (epic mode) ──
if [[ -n "$LABEL" ]]; then
  echo "Epic mode: fetching open issues with label \"${LABEL}\"..."
  label_issues=$(gh issue list --state open --label "$LABEL" --limit 500 \
    --json number --jq '[.[].number] | sort | .[]')
  if [[ -z "$label_issues" ]]; then
    echo "No open issues found with label \"${LABEL}\""
    exit 0
  fi
  while IFS= read -r num; do
    ISSUES+=("$num")
    echo "  Found open issue #${num}"
  done <<< "$label_issues"
  # Epic mode forces sequential execution so each issue builds on the last
  MAX_PARALLEL=1
  echo ""
  echo "Running ${#ISSUES[@]} issues sequentially (epic mode)"
fi

if [[ ${#ISSUES[@]} -eq 0 ]]; then
  echo "Usage: $0 [--max-parallel N] [--model MODEL] [--dry-run] [--label LABEL] <issue-numbers|ranges...>"
  echo ""
  echo "Arguments can be individual issue numbers or ranges (START..END)."
  echo "Ranges expand to all open issues within the range."
  echo "Use --label to fetch all open issues with a GitHub label (epic mode, sequential)."
  echo ""
  echo "Examples:"
  echo "  $0 102 103 104"
  echo "  $0 102..110                  # all open issues from 102 to 110"
  echo "  $0 50..60 102 103            # mix ranges and individual numbers"
  echo "  $0 --label epic/v2           # sequential epic: all issues with label"
  echo "  $0 --max-parallel 5 --model opus \$(gh issue list --label bug --json number --jq '.[].number')"
  exit 1
fi

LOG_DIR="/tmp/batch-issues"
mkdir -p "$LOG_DIR"

echo "Batch full-cycle: ${#ISSUES[@]} issues, max ${MAX_PARALLEL} parallel, model=${MODEL}"
echo "Logs: ${LOG_DIR}/"
echo ""

# ── Determine outcome by checking GitHub state ──
check_outcome() {
  local issue="$1"
  local exit_code="$2"
  local log_file="${LOG_DIR}/${issue}.log"
  local log_lines
  log_lines=$(wc -l < "$log_file" 2>/dev/null || echo "0")

  # Check if issue was closed (PR merged)
  local issue_state
  issue_state=$(gh issue view "$issue" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")

  # Find PR for this issue: check branch name contains issue number, or body contains "Closes #N"
  local pr_info
  pr_info=$(gh pr list --state all --limit 200 --json number,state,headRefName,body 2>/dev/null | \
    jq -r ".[] | select(
      (.headRefName | test(\"(^|[^0-9])${issue}([^0-9]|$)\")) or
      (.body // \"\" | test(\"(?i)(closes|fixes|resolves) #${issue}([^0-9]|$)\"))
    ) | \"\(.number) \(.state)\"" 2>/dev/null | head -1)

  local pr_num pr_state
  pr_num=$(echo "$pr_info" | cut -d' ' -f1)
  pr_state=$(echo "$pr_info" | cut -d' ' -f2)

  if [[ "$issue_state" == "CLOSED" ]]; then
    echo -e "[#${issue}] \033[32m✓ merged\033[0m (PR #${pr_num}, log: ${log_lines} lines)"
  elif [[ -n "$pr_num" && "$pr_state" == "OPEN" ]]; then
    echo -e "[#${issue}] \033[33m◐ PR open\033[0m (PR #${pr_num} not merged, log: ${log_lines} lines)"
  elif [[ -n "$pr_num" && "$pr_state" == "MERGED" ]]; then
    echo -e "[#${issue}] \033[32m✓ merged\033[0m (PR #${pr_num}, issue still open, log: ${log_lines} lines)"
  elif [[ "$exit_code" -ne 0 ]]; then
    echo -e "[#${issue}] \033[31m✗ failed\033[0m (exit ${exit_code}, log: ${log_lines} lines)"
  elif [[ "$log_lines" -eq 0 ]]; then
    echo -e "[#${issue}] \033[31m✗ no output\033[0m (agent produced no output, log: ${log_lines} lines)"
  else
    echo -e "[#${issue}] \033[33m? unclear\033[0m (exit ${exit_code}, issue ${issue_state}, log: ${log_lines} lines)"
  fi
}

RUNNING=0
PIDS=()
ISSUE_MAP=()

for issue in "${ISSUES[@]}"; do
  # Wait if at max parallel
  while [[ $RUNNING -ge $MAX_PARALLEL ]]; do
    for i in "${!PIDS[@]}"; do
      if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
        wait "${PIDS[$i]}" || true
        EXIT_CODE=$?
        check_outcome "${ISSUE_MAP[$i]}" "$EXIT_CODE"
        unset 'PIDS['"$i"']'
        unset 'ISSUE_MAP['"$i"']'
        RUNNING=$((RUNNING - 1))
      fi
    done
    # Compact arrays
    PIDS=("${PIDS[@]}")
    ISSUE_MAP=("${ISSUE_MAP[@]}")
    sleep 2
  done

  LOG_FILE="${LOG_DIR}/${issue}.log"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] #${issue}: echo \"full cycle issue #${issue}\" | claude -p --model ${MODEL} --allowedTools Bash,Read,Edit,Write,Glob,Grep,Agent"
  else
    echo "[starting] #${issue} -> ${LOG_FILE}"
    nohup bash -c "echo 'full cycle issue #${issue}' | claude -p \
      --model '${MODEL}' \
      --allowedTools 'Bash,Read,Edit,Write,Glob,Grep,Agent'" \
      > "$LOG_FILE" 2>&1 &
    PID=$!
    PIDS+=("$PID")
    ISSUE_MAP+=("$issue")
    RUNNING=$((RUNNING + 1))
  fi
done

# Wait for remaining
for i in "${!PIDS[@]}"; do
  wait "${PIDS[$i]}" || true
  EXIT_CODE=$?
  check_outcome "${ISSUE_MAP[$i]}" "$EXIT_CODE"
done

echo ""
echo "── Summary ──"
echo ""
for issue in "${ISSUES[@]}"; do
  check_outcome "$issue" 0
done
echo ""
echo "Logs: ${LOG_DIR}/"
