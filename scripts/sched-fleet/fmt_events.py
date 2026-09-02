import json, sys
KEEP = {"spawned", "stalled", "redispatched", "unit-failed", "unit-blocked", "teardown-failed", "parked"}
out = []
for line in sys.stdin:
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get("event") not in KEEP:
        continue
    bits = [d.get("event"), f"#{d.get('issue')}"]
    if d.get("tier"): bits.append(f"tier={d['tier']}")
    if d.get("reason"): bits.append(d["reason"])
    if d.get("pr"): bits.append(f"PR#{d['pr']}")
    out.append(" ".join(str(b) for b in bits))
print("\n".join(out[:8]))
