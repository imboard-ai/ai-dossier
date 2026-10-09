---
name: 'worktree-hygiene'
description: 'Reclaim leaked worktree-pool slots (closed + merged issues), clear pool debris and report stale worktrees; skips if it succeeded within the last hour; lock-serialized with a timestamped audit log'
metadata:
  dossier.dossier_schema_version: '1.0.0'
  dossier.title: 'Worktree Hygiene — Reclaim Leaked Pool Slots'
  dossier.version: '1.0.0'
  dossier.protocol_version: '"1.0"'
  dossier.status: 'Stable'
  dossier.last_updated: '2026-10-09'
  dossier.objective: 'Reclaim worktree-pool slots whose issues are closed and merged, clear pool-owned debris, and report other stale worktrees — idempotent, rate-limited by a last-success stamp, serialized by a lock, with a timestamped audit log.'
  dossier.category: '["development"]'
  dossier.tags: '["worktree","pool","cleanup","hygiene","git","fleet"]'
  dossier.risk_level: 'medium'
  dossier.risk_factors: '["modifies_files","network_access"]'
  dossier.requires_approval: 'false'
  dossier.destructive_operations: '["Returns finished pool worktrees to the pool (worktree-pool return)","Removes the pool''s own corrupted entries (worktree-pool gc)","Kills orphaned processes from removed worktrees older than 24h (worktree-pool reap)","Optionally removes foreign merged-clean worktrees (remove_foreign=true; branches are never deleted)"]'
  dossier.inputs: '{"optional":[{"default":60,"description":"Skip when the last SUCCESSFUL run is younger than this (env MIN_INTERVAL_MINUTES).","name":"min_interval_minutes","type":"number"},{"default":false,"description":"Run even when fresh (env FORCE).","name":"force","type":"boolean"},{"default":false,"description":"Report what would be reclaimed/removed; change nothing and do not stamp (env DRY_RUN).","name":"dry_run","type":"boolean"},{"default":false,"description":"Also remove foreign worktrees classified merged-clean (never deletes branches) (env REMOVE_FOREIGN).","name":"remove_foreign","type":"boolean"}]}'
  dossier.authors: '[{"name":"Yuval Dimnik"}]'
  dossier.checksum: '{"algorithm":"sha256","hash":"ef74446c896e001d24b0a9d63df547aea7e62924124dd04729826698df29b381"}'
  dossier.signature: '{"algorithm":"ed25519","covers":"spec-frontmatter+body","key_id":"imboard-ai","public_key":"m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=","signature":"7HdUXhtuKrFoJGkH8+UE9L/NxebSZ1hdMjc9HCipiP0Xwm4wq7Mea6qzwf4AL8Wu0dSJQycuXkAD8G0VRZ8YBw==","signed_at":"2026-10-09T21:36:24.054Z","signed_by":"Yuval Dimnik <yuval.dimnik@gmail.com>"}'
---
# Worktree Hygiene — Reclaim Leaked Pool Slots

## Objective

Runs that end without tearing down leave their worktree-pool slot **assigned** forever. The pool then reports "at capacity" although the work is long merged, and fleets lose their parallelism. This dossier returns those slots, clears the pool's own debris, and reports — never silently deletes — everything else. It is safe to call often: it does nothing when it succeeded recently, and concurrent callers wait for one another instead of racing.

**Composable:** `fleet-cycle` runs it before planning; `full-cycle-issue` runs it when a pool claim finds no warm slot; anyone can run it by hand. A skip or failure is never fatal to the caller.

## Prerequisites

- [ ] Inside the target git repository (any worktree of it)
- [ ] `gh` authenticated, `git`, `jq`, `bash` ≥ 4
- [ ] `@ai-dossier/worktree-pool` reachable via `npx` (or set `POOL_CLI`)
- [ ] Linux for the live-process guard (`/proc`); elsewhere that guard is skipped and the `in-progress` label is the active-run signal

## What it does

0. **Freshness gate (always audited).** Logs `start` with the full UTC timestamp, the last successful run's full timestamp and its age. If the last **successful** run is younger than `min_interval_minutes` (default 60) and `force` is not set, logs `skip-fresh` (again with both timestamps) and exits 0. Failed or interrupted runs never refresh the stamp.
1. **Lock — wait, don't blindly skip.** Takes an exclusive per-repository lock. If another run holds it, waits **15 s, up to 3 times**, logging each `wait` with the holder's run id. After each wait it checks whether the holder **finished successfully** (fresh stamp) → logs `covered` and exits 0. If the lock frees up, it takes it and proceeds. If the holder is still running after all waits → logs `gave-up`, exits **3** (non-fatal). A lock whose owner process is dead is broken and logged (`stale-lock-broken`). Under the lock, freshness is re-checked.
2. **Inventory** via `worktree-pool status --json`.
3. **Reclaim assigned slots** with `worktree-pool return` only when ALL hold: issue **closed**; no `in-progress` label; worktree **clean**; PR **merged** or HEAD already in the default branch; **no unpushed** commits (unless the PR merged); **no live process** inside it. Every other slot is logged `kept` with its reason (`open-issue`, `active-run-label`, `dirty`, `not-merged`, `unpushed`, `live-process`, `path-missing`, `issue-unreadable`).
4. **Pool-owned debris:** `worktree-pool gc --yes` (only ever the pool's own corrupted/stale entries — foreign worktrees are skipped by the tool) and `reap --older-than 24 --yes` (orphaned processes).
5. **Foreign worktrees** (created outside the pool) are classified `merged-clean`, `has-unique-work` or `unknown` and **reported**. Only with `remove_foreign=true` are `merged-clean` ones removed (`git worktree remove`; branches are never deleted).
6. **Stamp, then release.** On success writes `last_success_at` (+ epoch, run id, counts) atomically and logs `done`; on any failure logs `failed`, leaves the stamp untouched and exits 1. The lock is **always released** on exit — success, failure or interrupt — and only by its owner (`lock-released`).

**State and audit trail** (outside the repository; per repository slug, no local paths): `~/.dossier/state/worktree-hygiene/<owner>-<repo>.json` (last success) and `…/<owner>-<repo>.log.jsonl` (append-only, one JSON line per event, each with full UTC `at`, `run` id and `pid`).

## Actions to Perform

Write the script below to a temporary file and run it from inside the repository. Pass inputs as environment variables. Run it **in the foreground** and report its summary line (`done` / `skip-fresh` / `covered` / `gave-up` / `failed`) plus the `kept` reasons.

```bash
HYG=$(mktemp -t worktree-hygiene.XXXXXX.sh)
cat > "$HYG" <<'WORKTREE_HYGIENE_EOF'
#!/usr/bin/env bash
# worktree-hygiene: reclaim leaked worktree-pool slots and report other stale worktrees.
# Idempotent; skips when a successful run happened within MIN_INTERVAL_MINUTES; serialized by a lock.
# Env: MIN_INTERVAL_MINUTES (60) FORCE (false) DRY_RUN (false) REMOVE_FOREIGN (false)
#      LOCK_WAIT_SECONDS (15) LOCK_WAIT_TRIES (3) POOL_CLI (npx -y @ai-dossier/worktree-pool@^0.7.2)
# Exit: 0 = success / fresh skip / covered by a concurrent successful run
#       3 = a concurrent run was still holding the lock after all waits (non-fatal for callers)
#       1 = this run failed (stamp not updated)
set -uo pipefail

MIN=${MIN_INTERVAL_MINUTES:-60}; FORCE=${FORCE:-false}; DRY=${DRY_RUN:-false}
RM_FOREIGN=${REMOVE_FOREIGN:-false}; WAIT_S=${LOCK_WAIT_SECONDS:-15}; TRIES=${LOCK_WAIT_TRIES:-3}
POOL=${POOL_CLI:-npx -y @ai-dossier/worktree-pool@^0.7.2}

now_iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ; }
now_s() { date -u +%s; }

ROOT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##') || { echo "not in a git repo" >&2; exit 1; }
cd "$ROOT" || exit 1
SLUG=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null | tr '/' '-')
[ -n "$SLUG" ] || SLUG=$(basename "$ROOT")
DEFAULT=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null); DEFAULT=${DEFAULT:-main}
STATE="${HOME}/.dossier/state/worktree-hygiene"; mkdir -p "$STATE"
STAMP="$STATE/$SLUG.json"; LOG="$STATE/$SLUG.log.jsonl"; LOCK="$STATE/$SLUG.lock"
RUN="$(now_iso)-$$"
HAVE_LOCK=false

log() { # event [extra-json-fields]
  local line; line=$(printf '{"at":"%s","run":"%s","pid":%s,"event":"%s"%s}' "$(now_iso)" "$RUN" "$$" "$1" "${2:+,$2}")
  echo "$line" >> "$LOG"; echo "$line"
}
last_success_s() { jq -r '.last_success_epoch // empty' "$STAMP" 2>/dev/null; }
last_success_iso() { jq -r '.last_success_at // "never"' "$STAMP" 2>/dev/null || echo never; }
is_fresh() { local s; s=$(last_success_s); [ -n "$s" ] && [ $(( $(now_s) - s )) -lt $(( MIN * 60 )) ]; }
age_min() { local s; s=$(last_success_s); [ -n "$s" ] && echo $(( ( $(now_s) - s ) / 60 )) || echo null; }

release() {
  if $HAVE_LOCK && [ "$(cat "$LOCK/owner" 2>/dev/null)" = "$RUN" ]; then
    rm -rf "$LOCK"; HAVE_LOCK=false; log lock-released
  fi
}
trap 'rc=$?; release; exit $rc' EXIT
trap 'log interrupted; exit 1' INT TERM

acquire() {
  if mkdir "$LOCK" 2>/dev/null; then echo "$RUN" > "$LOCK/owner"; echo "$$" > "$LOCK/pid"; HAVE_LOCK=true; return 0; fi
  # stale lock: owner process gone
  local p; p=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then
    log stale-lock-broken "\"holder\":\"$(cat "$LOCK/owner" 2>/dev/null)\",\"holder_pid\":$p"
    rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null && { echo "$RUN" > "$LOCK/owner"; echo "$$" > "$LOCK/pid"; HAVE_LOCK=true; return 0; }
  fi
  return 1
}

log start "\"min_interval_minutes\":$MIN,\"force\":$FORCE,\"dry_run\":$DRY,\"remove_foreign\":$RM_FOREIGN,\"last_success_at\":\"$(last_success_iso)\",\"age_minutes\":$(age_min)"

# Step 0: freshness gate
if [ "$FORCE" != true ] && is_fresh; then
  log skip-fresh "\"last_success_at\":\"$(last_success_iso)\",\"age_minutes\":$(age_min)"; exit 0
fi

# Step 1: lock, waiting for a concurrent run instead of skipping blindly
if ! acquire; then
  holder=$(cat "$LOCK/owner" 2>/dev/null)
  for i in $(seq 1 "$TRIES"); do
    log wait "\"attempt\":$i,\"of\":$TRIES,\"sleep_seconds\":$WAIT_S,\"holder\":\"$holder\""
    sleep "$WAIT_S"
    if [ "$FORCE" != true ] && is_fresh; then
      log covered "\"by_last_success_at\":\"$(last_success_iso)\",\"holder\":\"$holder\""; exit 0
    fi
    acquire && break
  done
  if ! $HAVE_LOCK; then
    log gave-up "\"holder\":\"$(cat "$LOCK/owner" 2>/dev/null)\",\"waited_seconds\":$(( WAIT_S * TRIES ))"; exit 3
  fi
  log lock-acquired-after-wait
else
  log lock-acquired
fi
# double-check freshness under the lock (another run may have just finished)
if [ "$FORCE" != true ] && is_fresh; then log skip-fresh "\"last_success_at\":\"$(last_success_iso)\",\"under_lock\":true"; exit 0; fi

git fetch -q origin --prune 2>/dev/null || true
RECLAIMED=0; KEPT=0; FOREIGN_CAND=0; FOREIGN_REMOVED=0; FAILED=0

wt_dirty()    { git -C "$1" status --porcelain 2>/dev/null | wc -l | tr -d ' '; }
wt_unpushed() { git -C "$1" rev-list --count '@{u}..HEAD' 2>/dev/null || git -C "$1" rev-list --count "origin/$DEFAULT..HEAD" 2>/dev/null || echo 999; }
in_default()  { git merge-base --is-ancestor "$(git -C "$1" rev-parse HEAD 2>/dev/null)" "origin/$DEFAULT" 2>/dev/null; }
pr_merged()   { [ -n "$1" ] && [ "$(gh pr list --state merged --head "$1" --json number --jq 'length' 2>/dev/null)" -gt 0 ] 2>/dev/null; }
live_proc()   { # Linux: any process whose cwd is inside the worktree
  [ -d /proc ] || return 1
  local d; for d in /proc/[0-9]*; do case "$(readlink "$d/cwd" 2>/dev/null)" in "$1"|"$1"/*) return 0;; esac; done; return 1; }

STATUS=$($POOL status --json 2>/dev/null) || { log failed "\"step\":\"inventory\""; exit 1; }
POOLDIR=$(echo "$STATUS" | jq -r .pool_dir)

# Step 3: reclaim assigned slots whose work is finished
while IFS=$'\t' read -r path issue branch; do
  [ -n "$path" ] || continue
  abs="$POOLDIR/$path"; reason=""
  state=$(gh issue view "$issue" --json state,labels --jq '.state + " " + ([.labels[].name]|join(","))' 2>/dev/null)
  [ -n "$state" ] || reason="issue-unreadable"
  [ -z "$reason" ] && [ "${state%% *}" != CLOSED ] && reason="open-issue"
  [ -z "$reason" ] && [[ "$state" == *in-progress* ]] && reason="active-run-label"
  [ -z "$reason" ] && [ ! -d "$abs" ] && reason="path-missing"
  [ -z "$reason" ] && [ "$(wt_dirty "$abs")" != 0 ] && reason="dirty"
  if [ -z "$reason" ] && ! pr_merged "$branch" && ! in_default "$abs"; then reason="not-merged"; fi
  if [ -z "$reason" ] && ! pr_merged "$branch" && [ "$(wt_unpushed "$abs")" != 0 ]; then reason="unpushed"; fi
  [ -z "$reason" ] && live_proc "$abs" && reason="live-process"
  if [ -n "$reason" ]; then KEPT=$((KEPT+1)); log kept "\"issue\":$issue,\"path\":\"$path\",\"reason\":\"$reason\""; continue; fi
  if [ "$DRY" = true ]; then RECLAIMED=$((RECLAIMED+1)); log would-reclaim "\"issue\":$issue,\"path\":\"$path\""; continue; fi
  if $POOL return --path "$abs" >/dev/null 2>&1; then RECLAIMED=$((RECLAIMED+1)); log reclaimed "\"issue\":$issue,\"path\":\"$path\""
  else FAILED=$((FAILED+1)); log reclaim-failed "\"issue\":$issue,\"path\":\"$path\""; fi
done < <(echo "$STATUS" | jq -r '.worktrees[]|select(.status=="assigned" and .assigned_to_issue!=null)|[.path,(.assigned_to_issue|tostring),(.assigned_branch//"")]|@tsv')

# Step 4: pool-owned debris (gc only ever touches the pool's own entries)
if [ "$DRY" = true ]; then $POOL gc --dry-run >/dev/null 2>&1; $POOL reap --older-than 24 --dry-run >/dev/null 2>&1; log debris "\"mode\":\"dry-run\""
else
  $POOL gc --yes >/dev/null 2>&1 && g=ok || { g=failed; FAILED=$((FAILED+1)); }
  $POOL reap --older-than 24 --yes >/dev/null 2>&1 && r=ok || { r=failed; FAILED=$((FAILED+1)); }
  log debris "\"gc\":\"$g\",\"reap\":\"$r\""
fi

# Step 5: foreign worktrees — report (remove only merged+clean when REMOVE_FOREIGN=true; never delete branches)
while IFS=$'\t' read -r fpath fname; do
  [ -d "$fpath" ] || continue
  br=$(git -C "$fpath" branch --show-current 2>/dev/null)
  d=$(wt_dirty "$fpath"); u=$(wt_unpushed "$fpath")
  if [ "$d" = 0 ] && { in_default "$fpath" || pr_merged "$br"; } && { [ "$u" = 0 ] || pr_merged "$br"; } && ! live_proc "$fpath"; then
    cls="merged-clean"; FOREIGN_CAND=$((FOREIGN_CAND+1))
    if [ "$RM_FOREIGN" = true ] && [ "$DRY" != true ] && git worktree remove "$fpath" 2>/dev/null; then FOREIGN_REMOVED=$((FOREIGN_REMOVED+1)); cls="removed"; fi
  elif [ "$d" != 0 ] || [ "$u" != 0 ]; then cls="has-unique-work"; else cls="unknown"; fi
  log foreign "\"name\":\"$fname\",\"branch\":\"${br:-detached}\",\"class\":\"$cls\",\"dirty\":$d,\"unpushed\":$u"
done < <(echo "$STATUS" | jq -r '.foreign[]|[.path,.name]|@tsv')

# Step 6: stamp only on success, then release (EXIT trap)
if [ "$FAILED" -gt 0 ]; then
  log failed "\"reclaimed\":$RECLAIMED,\"kept\":$KEPT,\"failures\":$FAILED"; exit 1
fi
if [ "$DRY" != true ]; then
  tmp=$(mktemp "$STATE/.stamp.XXXXXX")
  printf '{"last_success_at":"%s","last_success_epoch":%s,"run":"%s","reclaimed":%s,"kept":%s,"foreign_candidates":%s,"foreign_removed":%s}\n' \
    "$(now_iso)" "$(now_s)" "$RUN" "$RECLAIMED" "$KEPT" "$FOREIGN_CAND" "$FOREIGN_REMOVED" > "$tmp" && mv "$tmp" "$STAMP"
fi
log done "\"dry_run\":$DRY,\"reclaimed\":$RECLAIMED,\"kept\":$KEPT,\"foreign_candidates\":$FOREIGN_CAND,\"foreign_removed\":$FOREIGN_REMOVED"
exit 0
WORKTREE_HYGIENE_EOF
chmod +x "$HYG"
MIN_INTERVAL_MINUTES=60 FORCE=false DRY_RUN=false REMOVE_FOREIGN=false "$HYG"; rc=$?
rm -f "$HYG"
echo "worktree-hygiene exit=$rc"
```

**Exit codes:** `0` success, fresh skip, or covered by a concurrent successful run · `3` a concurrent run still held the lock after 3 × 15 s (non-fatal — proceed) · `1` this run failed (stamp unchanged; inspect the log).

## Composition (for calling dossiers)

```bash
ai-dossier run imboard-ai/git/worktree-hygiene   # cheap when fresh; never fatal
```
- **fleet-cycle** — Phase 0, before computing wave sizes and pre-warming, so capacity is real.
- **full-cycle-issue / setup** — only when a pool claim finds **0 warm** slots; then retry the claim once.
- Treat exits 1 and 3 as warnings; never block a run on hygiene.

## Validation

- [ ] `start` and the terminal event are both in the log with full UTC timestamps
- [ ] No slot was returned unless its issue is closed, merged, clean, unpushed=0 and process-free
- [ ] The stamp changed only on `done` (never on dry run, skip, covered, gave-up or failed)
- [ ] No lock directory remains after the run (unless another live run owns it)

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Pool "at capacity" but issues are merged | Runs exited before teardown. Run this dossier (or `force=true` if it ran < 1 h ago). |
| `kept … not-merged` for a merged PR | Squash merge with the branch deleted and the PR lookup failing — check `gh auth status`; the slot is kept (safe default). |
| `gave-up` repeatedly | A run is stuck holding the lock. If its pid is alive, investigate it; a dead holder is broken automatically next run. |
| `kept … live-process` | A dev server or test run still uses the worktree. Stop it, then rerun. |

## Notes

Tested on release (2026-10-09): single run, two serial runs (both `skip-fresh`), three parallel runs (one `lock-acquired` → `done`; two `wait`×3 → `covered`), a live lock holder (`gave-up`, exit 3, holder's lock untouched), and a dead holder (`stale-lock-broken`, then normal run).
