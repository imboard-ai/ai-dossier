"""Containment witness for pip lifecycle hooks (owner decision on #1009).

Records only where it ran, its uid and effective capabilities, and whether the
planted host-env / host-file canaries named in targets.json are visible.
Contains no network code; egress is enforced outside the guest.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def witness(phase):
    with open(os.path.join(HERE, "targets.json")) as handle:
        targets = json.load(handle)
    with open("/proc/self/status") as handle:
        status = dict(line.split(":", 1) for line in handle if ":" in line)
    cap_eff = status.get("CapEff", "").strip()
    records = [
        {"category": "witness", "attempt": "executed:" + phase, "outcome": "observed",
         "detail": "container" if os.path.exists("/.dockerenv") else "not-container"},
        {"category": "privilege-escalation", "attempt": "uid",
         "outcome": "succeeded" if os.getuid() == 0 else "denied", "detail": str(os.getuid())},
        {"category": "privilege-escalation", "attempt": "capabilities",
         "outcome": "denied" if int(cap_eff or "1", 16) == 0 else "succeeded", "detail": cap_eff},
        {"category": "host-env", "attempt": "env:" + targets["envName"],
         "outcome": "succeeded" if targets["envName"] in os.environ else "denied", "detail": ""},
        {"category": "host-file", "attempt": "exists:" + targets["hostFile"],
         "outcome": "succeeded" if os.path.exists(targets["hostFile"]) else "denied", "detail": ""},
    ]
    report = {"probe": "python", "phase": phase, "records": records}
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    with open(os.path.join(HERE, "results", "python-%s.json" % phase), "w") as handle:
        json.dump(report, handle)
    print("ZT-PROBE-REPORT " + json.dumps(report))


if __name__ == "__main__":
    import sys

    witness(sys.argv[1] if len(sys.argv) > 1 else "test")
