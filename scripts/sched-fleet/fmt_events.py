import json, sys
KEEP = {
    "spawned",
    "stalled",
    "redispatched",
    "unit-failed",
    "unit-blocked",
    "teardown-failed",
    "parked",
    "dispatch-profile-missing",
    # #810: a member's own hand-back is parked (not a failure), a threshold
    # crossing over validated work does not dissolve, and an operator requeue.
    "member-handed-back",
    "dissolve-suppressed",
    "member-requeued",
    "batch-blocked",
    # #822: an operator resumed a batch over its landed work; a member that
    # ran the wrong procedure was re-prompted once.
    "batch-resumed",
    "member-reprompted",
    # #824: an operator recorded a blocked batch's PR by hand (sched attach-pr).
    "pr-attached",
    # #844: an agent ignored SIGTERM and was SIGKILLed; a serial batch advanced
    # past a member evicted by an engine that exited before advancing.
    "kill-escalated",
    "member-advance-recovered",
}
out = []
for line in sys.stdin:
    try:
        d = json.loads(line)
    except Exception:
        continue
    event = d.get("event")
    if event not in KEEP:
        continue
    issue = d.get("issue")
    unit = d.get("unit")
    identity = f"#{issue}" if isinstance(issue, int) else unit if isinstance(unit, str) else "?"
    bits = [event, identity]
    if d.get("tier"): bits.append(f"tier={d['tier']}")
    if d.get("reason"): bits.append(d["reason"])
    if d.get("pr"): bits.append(f"PR#{d['pr']}")
    if event in ("dispatch-profile-missing", "dissolve-suppressed", "batch-blocked", "batch-resumed") and d.get("detail"): bits.append(d["detail"])
    out.append(" ".join(str(b) for b in bits))
print("\n".join(out[:8]))
