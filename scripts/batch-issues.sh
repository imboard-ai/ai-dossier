#!/usr/bin/env bash
#
# batch-issues.sh — Batch-process GitHub issues via Claude Code agents
#
# Spawns a Claude Code agent per issue, each running the full-cycle-issue skill
# (read issue → create branch → implement → PR → merge). Supports two modes:
#
#   Parallel mode (default)  — up to N agents run concurrently
#   Epic mode (--label)      — issues run one-at-a-time so each builds on the
#                              previous one's merged changes
#
# ── Prerequisites ──────────────────────────────────────────────────────────
#   - gh CLI authenticated with repo access
#   - claude CLI on PATH
#   - jq installed
#
# ── Arguments ──────────────────────────────────────────────────────────────
#   <number>       Individual issue number (e.g. 102)
#   <start>..<end> Range of issue numbers; expands to all OPEN issues in range
#   Arguments can be mixed freely: ./batch-issues.sh 50..60 102 103
#
# ── Options ────────────────────────────────────────────────────────────────
#   --label LABEL      Fetch all open issues with this GitHub label.
#                      Forces sequential execution (epic mode, --max-parallel 1).
#                      Issues are sorted by number (lowest first).
#                      Can be combined with explicit issue numbers/ranges.
#   --pool             Pre-warm worktree pool before spawning agents, gc after
#   --max-parallel N   Max concurrent agents (default: 3, ignored in epic mode)
#   --model MODEL      Claude model to use (default: opus)
#   --dry-run          Print the commands that would run without executing
#   --json             Output final summary as a JSON array (in addition to human text)
#   --agent            Machine-readable mode: implies --json, all progress goes to
#                      stderr so stdout contains ONLY the JSON summary.
#                      Ideal for piping into another tool or AI agent.
#
# ── Output ─────────────────────────────────────────────────────────────────
#   Logs:    /tmp/batch-issues/<issue-number>.log  (one per issue)
#   Summary: printed at end with per-issue outcome:
#            ✓ merged  — PR merged and/or issue closed
#            ◐ PR open — PR created but not yet merged
#            ✗ failed  — agent exited with error or produced no output
#            ? unclear — agent exited 0 but no PR found
#
#   JSON output (--json / --agent):
#     [
#       {
#         "issue": 102,
#         "status": "merged",       // merged | pr_open | failed | no_output | unclear
#         "pr": 45,                 // PR number or null
#         "issue_state": "CLOSED",  // OPEN | CLOSED | UNKNOWN
#         "exit_code": 0,
#         "log_file": "/tmp/batch-issues/102.log",
#         "log_lines": 234
#       }
#     ]
#
# ── Examples ───────────────────────────────────────────────────────────────
#   # Process three specific issues in parallel (max 3)
#   ./scripts/batch-issues.sh 102 103 104
#
#   # All open issues in a range
#   ./scripts/batch-issues.sh 102..110
#
#   # Epic mode: work through a labeled backlog sequentially
#   ./scripts/batch-issues.sh --label epic/v2
#
#   # Combine label with extra issues
#   ./scripts/batch-issues.sh --label sprint-3 200 201
#
#   # High parallelism with a specific model
#   ./scripts/batch-issues.sh --max-parallel 5 --model opus 102..120
#
#   # Preview what would run
#   ./scripts/batch-issues.sh --dry-run --label epic/v2
#
#   # JSON summary appended after human output
#   ./scripts/batch-issues.sh --json 102 103
#
#   # Agent mode: stdout is pure JSON, progress on stderr
#   ./scripts/batch-issues.sh --agent --label epic/v2
#   ./scripts/batch-issues.sh --agent 102..110 | jq '.[] | select(.status != "merged")'
#
#   # Pipe from gh CLI
#   ./scripts/batch-issues.sh $(gh issue list --label "agent-friendly" --json number --jq '.[].number')

set -uo pipefail

# cd to repo root so agents start in the right place
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

MAX_PARALLEL=3
DRY_RUN=false
MODEL="opus"
LABEL=""
JSON_OUTPUT=false
AGENT_MODE=false
USE_POOL=false
ISSUES=()

# ── log: prints to stderr in agent mode, stdout otherwise ──
# Defined early so it's available during arg parsing (range/label discovery).
# Passes all args through to echo (including flags like -e for ANSI colors).
log() {
  if [[ "$AGENT_MODE" == "true" ]]; then
    echo "$@" >&2
  else
    echo "$@"
  fi
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --max-parallel) MAX_PARALLEL="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --model)        MODEL="$2"; shift 2 ;;
    --label)        LABEL="$2"; shift 2 ;;
    --json)         JSON_OUTPUT=true; shift ;;
    --agent)        AGENT_MODE=true; JSON_OUTPUT=true; shift ;;
    --pool)         USE_POOL=true; shift ;;
    *)
      if [[ "$1" =~ ^([0-9]+)\.\.([0-9]+)$ ]]; then
        range_start="${BASH_REMATCH[1]}"
        range_end="${BASH_REMATCH[2]}"
        if [[ "$range_start" -gt "$range_end" ]]; then
          echo "Error: invalid range ${range_start}..${range_end} (start > end)" >&2
          exit 1
        fi
        log "Fetching open issues in range ${range_start}..${range_end}..."
        # Fetch all open issues and filter to the range
        range_issues=$(gh issue list --state open --limit 500 --json number --jq \
          "[.[].number | select(. >= ${range_start} and . <= ${range_end})] | sort | .[]")
        if [[ -z "$range_issues" ]]; then
          log "  No open issues found in range ${range_start}..${range_end}"
          exit 0
        else
          while IFS= read -r num; do
            ISSUES+=("$num")
            log "  Found open issue #${num}"
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
  log "Epic mode: fetching open issues with label \"${LABEL}\"..."
  label_issues=$(gh issue list --state open --label "$LABEL" --limit 500 \
    --json number --jq '[.[].number] | sort | .[]')
  if [[ -z "$label_issues" ]]; then
    log "No open issues found with label \"${LABEL}\""
    exit 0
  fi
  while IFS= read -r num; do
    ISSUES+=("$num")
    log "  Found open issue #${num}"
  done <<< "$label_issues"
  # Epic mode forces sequential execution so each issue builds on the last
  MAX_PARALLEL=1
  log ""
  log "Running ${#ISSUES[@]} issues sequentially (epic mode)"
fi

if [[ ${#ISSUES[@]} -eq 0 ]]; then
  echo "Usage: $0 [options] <issue-numbers|ranges...>"
  echo ""
  echo "Arguments:  102          individual issue"
  echo "            102..110     range → all open issues between 102 and 110"
  echo ""
  echo "Options:"
  echo "  --label LABEL      fetch open issues by label (epic mode, sequential)"
  echo "  --max-parallel N   concurrent agents (default: 3, forced to 1 in epic mode)"
  echo "  --model MODEL      Claude model (default: opus)"
  echo "  --dry-run          print commands without executing"
  echo "  --json             append JSON summary array to stdout"
  echo "  --agent            machine-readable: --json + progress on stderr only"
  echo "  --pool             pre-warm worktree pool before spawning agents"
  echo ""
  echo "Examples:"
  echo "  $0 102 103 104                         # three issues in parallel"
  echo "  $0 102..110                             # open issues in range"
  echo "  $0 --label epic/v2                      # epic: label issues sequentially"
  echo "  $0 --dry-run --label sprint-3           # preview epic run"
  exit 1
fi

LOG_DIR="/tmp/batch-issues"
mkdir -p "$LOG_DIR"

log "Batch full-cycle: ${#ISSUES[@]} issues, max ${MAX_PARALLEL} parallel, model=${MODEL}"
log "Logs: ${LOG_DIR}/"
log ""

# ── Pool pre-warming ──
if [[ "$USE_POOL" == "true" ]]; then
  log "Pre-warming ${#ISSUES[@]} pool worktrees..."
  if [[ "$DRY_RUN" == "true" ]]; then
    log "[dry-run] npx worktree-pool replenish --count ${#ISSUES[@]}"
  else
    npx worktree-pool replenish --count "${#ISSUES[@]}" 2>&1 | while IFS= read -r line; do log "  [pool] $line"; done
  fi
  log ""
fi

# ── Determine outcome by checking GitHub state ──
# Prints human-readable line (via log) and appends to JSON_RESULTS array.
JSON_RESULTS=()

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

  local pr_num pr_state status
  pr_num=$(echo "$pr_info" | cut -d' ' -f1)
  pr_state=$(echo "$pr_info" | cut -d' ' -f2)

  if [[ "$issue_state" == "CLOSED" ]]; then
    status="merged"
    log -e "[#${issue}] \033[32m✓ merged\033[0m (PR #${pr_num}, log: ${log_lines} lines)"
  elif [[ -n "$pr_num" && "$pr_state" == "OPEN" ]]; then
    status="pr_open"
    log -e "[#${issue}] \033[33m◐ PR open\033[0m (PR #${pr_num} not merged, log: ${log_lines} lines)"
  elif [[ -n "$pr_num" && "$pr_state" == "MERGED" ]]; then
    status="merged"
    log -e "[#${issue}] \033[32m✓ merged\033[0m (PR #${pr_num}, issue still open, log: ${log_lines} lines)"
  elif [[ "$exit_code" -ne 0 ]]; then
    status="failed"
    log -e "[#${issue}] \033[31m✗ failed\033[0m (exit ${exit_code}, log: ${log_lines} lines)"
  elif [[ "$log_lines" -eq 0 ]]; then
    status="no_output"
    log -e "[#${issue}] \033[31m✗ no output\033[0m (agent produced no output, log: ${log_lines} lines)"
  else
    status="unclear"
    log -e "[#${issue}] \033[33m? unclear\033[0m (exit ${exit_code}, issue ${issue_state}, log: ${log_lines} lines)"
  fi

  # Collect structured result for JSON output
  if [[ "$JSON_OUTPUT" == "true" ]]; then
    local pr_json="${pr_num:-null}"
    [[ "$pr_json" != "null" ]] && pr_json="$pr_json"
    JSON_RESULTS+=("$(jq -n \
      --argjson issue "$issue" \
      --arg status "$status" \
      --arg pr_num "${pr_num:-}" \
      --arg issue_state "$issue_state" \
      --argjson exit_code "$exit_code" \
      --arg log_file "$log_file" \
      --argjson log_lines "$log_lines" \
      '{
        issue: $issue,
        status: $status,
        pr: (if $pr_num == "" then null else ($pr_num | tonumber) end),
        issue_state: $issue_state,
        exit_code: $exit_code,
        log_file: $log_file,
        log_lines: $log_lines
      }')")
  fi
}

RUNS_LOG="$HOME/.dossier/runs.jsonl"

# ── Show dossier trace info at job start ──
show_start_trace() {
  local issue="$1"
  local cache_dir="$HOME/.dossier/cache/imboard-ai/full-cycle-issue"
  local ver="?"
  local src="unknown"
  # Read cached version from meta
  if [[ -d "$cache_dir" ]]; then
    local meta
    meta=$(ls -t "$cache_dir"/*.meta.json 2>/dev/null | head -1)
    if [[ -n "$meta" ]]; then
      ver=$(jq -r '.version // "?"' "$meta" 2>/dev/null || echo "?")
      src="cache"
      local latest
      latest=$(jq -r '.latest_known_version // empty' "$meta" 2>/dev/null)
      if [[ -n "$latest" && "$latest" != "$ver" ]]; then
        log -e "         \033[33m⚠ update: ${latest} available (cached: ${ver})\033[0m"
      fi
    fi
  fi
  log "         dossier: full-cycle-issue@${ver} (${src})"
}

# ── Show dossier trace info at job completion ──
show_end_trace() {
  local issue="$1"
  if [[ ! -f "$RUNS_LOG" ]]; then return; fi
  # Find the most recent run-log entries created during this job
  local entries
  entries=$(tail -20 "$RUNS_LOG" | jq -r 'select(.dossier | test("full-cycle-issue")) | "\(.dossier)@\(.resolved_version) via \(.source)"' 2>/dev/null | tail -1)
  if [[ -n "$entries" ]]; then
    log "         trace: ${entries}"
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
        show_end_trace "${ISSUE_MAP[$i]}"
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

  # Build agent prompt — add pool hint if --pool is active
  AGENT_PROMPT="full cycle issue #${issue}"
  if [[ "$USE_POOL" == "true" ]]; then
    AGENT_PROMPT="full cycle issue #${issue}. Use 'npx worktree-pool claim --issue ${issue} --branch <branch>' to claim a pre-warmed worktree instead of creating a new one."
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log "[dry-run] #${issue}: claude -p --model ${MODEL} --allowedTools Bash,Read,Edit,Write,Glob,Grep,Agent"
  else
    log "[starting] #${issue} -> ${LOG_FILE}"
    show_start_trace "$issue"
    PROMPT_FILE="$(mktemp)"
    printf '%s' "${AGENT_PROMPT}" > "$PROMPT_FILE"
    nohup bash -c "cat '$PROMPT_FILE' | claude -p \
      --model '${MODEL}' \
      --allowedTools 'Bash,Read,Edit,Write,Glob,Grep,Agent'; rm -f '$PROMPT_FILE'" \
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
  show_end_trace "${ISSUE_MAP[$i]}"
done

log ""
log "── Summary ──"
log ""
for issue in "${ISSUES[@]}"; do
  check_outcome "$issue" 0
done
log ""
log "Logs: ${LOG_DIR}/"

# ── Pool cleanup ──
if [[ "$USE_POOL" == "true" && "$DRY_RUN" != "true" ]]; then
  log ""
  log "Cleaning up worktree pool..."
  npx worktree-pool gc 2>&1 | while IFS= read -r line; do log "  [pool] $line"; done
fi

# ── JSON output ──
if [[ "$JSON_OUTPUT" == "true" && ${#JSON_RESULTS[@]} -gt 0 ]]; then
  printf '%s\n' "${JSON_RESULTS[@]}" | jq -s '.'
fi
