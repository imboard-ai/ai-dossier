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
    if event == "dispatch-profile-missing" and d.get("detail"): bits.append(d["detail"])
    out.append(" ".join(str(b) for b in bits))
print("\n".join(out[:8]))
