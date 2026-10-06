# Decision record: local VM execution profile (feasibility gate 1)

- Issue: #1009 (parent #1002, slice S1). PRD §5.4, §5.5, §9 gate 1; scenarios 4, 5, 20.
- Status: **GO** — the boundary held under KVM in CI (evidence below). Gate 1 passes; #1010 and
  the S2–S5 execution work are unblocked.
- Date: 2026-10-06

## Decision

Untrusted repository code runs in a disposable **local QEMU VM** that the controller creates and
destroys per run. Inside the VM, every worker command runs in a hardened container. The VM gets
no network path to the host, the LAN, metadata services or the internet, no shared host
filesystem, and no credentials. The only way in or out is a narrow broker on a virtio-serial port.

Owner decisions that bound this record (not revisited here): local VM only, no cloud provider;
plain Docker on the host is rejected (shared kernel; PRD "no weaker fallback"); the gate suite
runs on GitHub-hosted Linux runners under KVM; machines without `/dev/kvm` use TCG with the same
image and configuration.

## Evidence

CI run [37510359866](https://github.com/imboard-ai/ai-dossier/actions/runs/37510359866) (GitHub-hosted
`ubuntu-24.04`, KVM, the code in this record), artifact `zero-trust-vm-evidence-kvm`. Earlier runs
[37499725515](https://github.com/imboard-ai/ai-dossier/actions/runs/37499725515) and
[37509153781](https://github.com/imboard-ai/ai-dossier/actions/runs/37509153781) gave the same
verdict and coverage.

- Boundary held: **yes**, 0 violations, 126 judged attempts, 0 connections on the planted host
  listeners, no canary value (raw, hex or base64) in any guest output.
- Coverage (attempts per category): host-env 6, host-file 18, host-loopback 8, lan 4, metadata 8,
  direct-egress 8, dns 16, privilege-escalation 22, container-escape 18, broker-abuse 16
  (9 from the worker, 7 host-side rejections), witness 2.
- Reports: npm `preinstall`, `postinstall`, `test` (31 attempts each, all denied); pip install and
  test witnesses (ran in the container as uid 1000 with no capabilities, canaries not visible);
  and the `vm-root` run (16 host-enforced attempts as root on the VM network stack, all denied:
  host gateway and loopback refused, LAN, metadata and internet unreachable, every DNS query
  unanswered).

The suite runs again on every pull request that touches `packages/zero-trust/`.

## Host preflight

Host preflight (`src/vm/host.ts`) and the adapter (`src/vm/local-qemu.ts`, `src/vm/profile.ts`)
refuse closed with reason `unsupported_environment` and a detail code. There is no fallback to
host Docker, and the container runtime is never probed on the host.

| Condition | Detail |
|---|---|
| Host OS is not Linux (macOS and Windows are follow-ups) | `unsupported_os` |
| Host is not x86_64 (the pinned image is amd64) | `unsupported_arch` |
| `qemu-system-x86_64` not on PATH | `qemu_missing` |
| `qemu-img` not on PATH | `qemu_img_missing` |
| No `genisoimage`/`mkisofs`/`xorrisofs` (cloud-init seed) | `iso_tool_missing` |
| `kvm` requested but `/dev/kvm` is not read-write for this user | `kvm_unavailable` (never downgraded) |
| No baked profile, or a manifest that is not private (mode 0600, this user) | `profile_image_missing` |
| A manifest that does not match the current pins, recipe or guest agent, an image digest mismatch, or a qcow2 that names a backing or data file | `profile_image_mismatch` |
| Broker socket path over 107 bytes | `socket_path_too_long` |
| Incident kill switch engaged | `kill_switch_engaged` |

PATH lookups ignore relative entries. QEMU and `qemu-img` run with a scrubbed environment
(`PATH`, `LANG` only), so nothing in the controller's environment reaches them.

## QEMU flags

Built by `src/vm/qemu-args.ts` from controller policy only. Nothing comes from repository,
worker or model input, and any value containing a comma, newline or NUL is refused (a comma would
inject extra QEMU sub-options).

Run VM (untrusted code):

| Flag | Why |
|---|---|
| `-machine q35,accel=kvm\|tcg`, `-cpu host` (KVM) / `-cpu max` (TCG) | Accelerator from preflight; recorded in the `vm_created` journal event, and the receipt schema (`ztfc-receipt-v2`) requires it in `profile.accelerator`, which the caller takes from `VmHandle.accelerator` |
| `-smp N -m MiB`, overlay disk `qemu-img create -b <baked image> <size>` | PRD §5.1 limits (default 4 vCPU, 8 GiB, 20 GiB) |
| `-nodefaults -no-user-config -display none -no-reboot` | No implicit devices, no host config files, no display, reboot ends the VM |
| `-sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny` | QEMU's own seccomp filter: no privilege change, no helper processes |
| `-serial none` | No guest-controlled console file on the host (disk-fill vector) |
| `-netdev user,id=net0,restrict=on` + `virtio-net-pci` | User-mode networking isolated from the host and the outside (below); no `hostfwd`/`guestfwd`. The value is rendered from `RUN_NETWORK_POLICY` |
| `virtio-serial-pci` + `-chardev socket,path=<0700 runtime dir>/<vm>.sock,server=on,wait=off` + `virtserialport,name=org.ai-dossier.zt.broker` | The broker channel, the only data path |
| `-smbios type=11,value=org.ai-dossier.zt.scope:container\|vm-root` | Controller-set execution scope as an SMBIOS OEM string; the guest agent reads it through `dmi_sysfs`, announces it back, and a mismatch taints the VM. (fw_cfg was tried first; the cloud image kernel does not ship `qemu_fw_cfg`, and the agent fell back to `container`, which is the safe default.) |
| `-drive file=<overlay>,if=virtio,format=qcow2,discard=unmap`, `virtio-rng-pci` | Per-run copy-on-write disk on the hash-verified baked image |
| `-pidfile` | Written for operators and diagnostics; teardown uses the recorded spawn PID and checks its process start token before signalling |

No `-virtfs`, `-fsdev`, virtiofs, 9p or `vhost-user-fs` device exists in the run arguments, and
unit tests assert their absence. QEMU is started detached in its own session by the controller
instead of `-daemonize`, because `-daemonize` (fork/setsid) does not combine with
`-sandbox ...,spawn=deny`.

Bake VM (trusted, pinned inputs only): the same base flags, plus the cloud-init seed as a
read-only drive, `-serial file:<console>` for the result marker, and unrestricted user-mode
networking for the Ubuntu archive and the container registry. No repository or model content is
involved in a bake.

## Image and container profile

- Base: Ubuntu 24.04 cloud image `release-20260926`, SHA-256 pinned, re-verified on every use
  of the download cache.
- Bake (`src/vm/cloud-init.ts`, `src/vm/bake.ts`): no users, no passwords, SSH disabled and
  masked, apt timers masked, root locked, snapd and unattended upgrades purged, cloud-init disabled after the bake.
  Node and Python container images derive from
  `mcr.microsoft.com/devcontainers/base:ubuntu24.04` pinned by digest; sudo is purged and every
  setuid/setgid bit is stripped at build time. The flattened image is hashed into a manifest
  together with the profile digest (pins, recipe version, guest agent source). The adapter
  re-hashes the image before its first VM and refuses a qcow2 whose header names a backing file
  or an external data file (QEMU would open either with the controller's privileges).
- Worker container (`vm-guest/agent.py`): `--network none --cap-drop ALL --security-opt
  no-new-privileges=true --read-only --tmpfs /tmp --pids-limit 1024 --memory/--memory-swap
  --cpus --user 1000:1000`, only the workspace bind-mounted.

## Network design

Egress is enforced **outside the VM**, by QEMU on the host, so it holds no matter what runs as
root inside the VM:

- QEMU user-mode networking (slirp) with `restrict=on`: the guest can reach only slirp's own
  internal services. Connections to the host gateway (`10.0.2.2`, which slirp would otherwise
  map to the host's loopback), the LAN, the metadata addresses (`169.254.169.254`,
  `fd00:ec2::254`) and the internet are dropped. slirp's DNS forwarder (`10.0.2.3`) does not
  answer under `restrict=on`, so DNS cannot be used for exfiltration either.
- No forwards in build and test phases. The provisioning phase (#1010) has exactly one forward:
  a `hostfwd` from a host loopback port to the guest relay, through which the controller dials in
  and splices each connection to the package mirror. The guest still opens no connection of its
  own. The phase ends by powering the guest off and restarting it on the same disk with the
  forward-free arguments. See the [package-proxy record](package-proxy.md) for why it is a
  `hostfwd` and not a `guestfwd`.
- Inside the VM, worker containers have `--network none`: a second, independent layer.
- The gate exercises both layers: the fixtures run once in the worker container, and once as
  root on the VM's own network stack (scope `vm-root`, assumed container escape). Only categories
  the host enforces are judged in the `vm-root` run, since root in the VM is root by design.

## Broker

`src/vm/broker.ts` (host) and `vm-guest/agent.py` (guest): JSON lines over virtio-serial with
three operations — `exec`, `put`, `get` — after a protocol hello. The host validates every request
before it is sent (operation allowlist, container profile, argv count and size, secret-shaped
argv, workspace-relative paths without traversal, 1 MiB file cap, timeout bounds) and every
response it receives (frame size cap, schema, request id, canonical base64, stream caps, short
error slugs). Any protocol violation by the guest taints the VM permanently; it must be
destroyed. A request the host rejects never reaches the guest and does not taint the VM. The
guest walks workspace paths with `O_NOFOLLOW` from the workspace root and opens files it writes
non-blocking, so a FIFO planted by worker code cannot wedge it. The VM holds no model, GitHub or
other credentials.

## Accelerator choice and measured overhead

KVM is used when `/dev/kvm` is read-write for the controller's user; otherwise TCG. A forced `kvm`
request without KVM is refused, never downgraded. TCG is the same image and the same isolation;
only clocks change: command and broker request timeouts ×4, and boot timeout 20 min (KVM: 3 min).
The accelerator is recorded in the `vm_created` journal event and bound into the receipt
(`profile.accelerator`).

Measured on GitHub-hosted `ubuntu-24.04` runners (same image, same smoke workload; the TCG
job has no `/dev/kvm` access). Ranges cover three CI runs (37499725515, 37509153781,
37510359866); runner hardware varies between runs, which shows up mostly under TCG:

| Step | KVM | TCG | TCG / KVM |
|---|---|---|---|
| Boot to broker ready | 12.5–13.3 s | 61.6–102.5 s | 4.9–7.7× |
| `node -e` in the Node container | 0.52–0.57 s | 5.0–7.6 s | 8.8–14× |
| `python3 -c` in the Python container | 0.27–0.32 s | 2.7–4.1 s | 10–15× |
| Destroy | 0.10 s | 0.10 s | 1× |
| Smoke total | 13.4–14.2 s | 69.5–114.3 s | 5.1–8.0× |
| Profile bake | 191–194 s | not measured in CI | — |

Hostile suite under KVM (run 37510359866): worker VM boot 10.5 s, `npm install` with lifecycle
scripts 25.2 s, `npm test` 12.8 s, pip install 3.4 s, pip test 0.8 s, `vm-root` VM boot 10.8 s and
probe 12.5 s; the whole KVM job, including setup and the smoke test, took under 3 minutes with
a cached profile. The probe time is dominated by its own 3–4 s connection and DNS timeouts.

On a development machine without `/dev/kvm`, a TCG bake ran for over an hour without finishing
(the earlier sketch measured about 330 s for the unbaked image's first boot alone), so bakes belong
on a KVM host or in CI. Container start-up costs more under TCG than the ×4 command-timeout scale
assumes for short commands (8.8–15×); the 20-minute base timeout leaves headroom for build and
test commands, but the scale should be re-measured with real repositories in #1010.

## Attack categories (scenario 4)

Canary design (owner decision on #1009): each category has a known target planted fresh, with
random values, by the harness before each run. Fixtures never search for or collect real
credentials.

| Category | Planted target / attempt | Enforced by |
|---|---|---|
| `host-env` | Random variable in the QEMU parent (controller) process environment | Scrubbed QEMU environment; VM boundary |
| `host-file` | Random secret file in a temporary host home directory; read at its host path and common share mount points | No host filesystem sharing |
| `host-loopback` | TCP listener on host `127.0.0.1`, tried via the slirp gateway `10.0.2.2` and directly | slirp `restrict=on` |
| `lan` | TCP listener on a host non-loopback address | slirp `restrict=on` |
| `metadata` | `169.254.169.254:80`, `[fd00:ec2::254]:80` | slirp `restrict=on` |
| `direct-egress` | Public addresses (`1.1.1.1:443`, `8.8.8.8:53`) | slirp `restrict=on` |
| `dns` | Resolver lookup of a unique name, raw UDP queries to `10.0.2.3`, `1.1.1.1`, `8.8.8.8`; any answer (even NXDOMAIN) counts as a leak | slirp `restrict=on` |
| `privilege-escalation` | uid 0, `sudo -n`, user namespaces, effective capabilities, `NoNewPrivs`, writes to `/etc` | Container profile |
| `container-escape` | Docker and containerd sockets, shared-filesystem mounts, block devices, `mount` | Container profile; no shared folders |
| `broker-abuse` | Worker opening the virtio broker port; host side: operation outside the set, traversal and absolute paths, oversize file, unknown profile, oversize argv | Container device set; host validation |

The npm fixture (`fixtures/hostile/npm-lifecycle`) attempts every category from `preinstall`,
`postinstall` and `npm test`.

### pip coverage: containment witness

The pip fixture (`fixtures/hostile/pip-setup`) is a minimal containment witness, by owner
decision: its `setup.py` (run by pip during install) and its test record only that they executed
inside the worker container, their uid and effective capabilities, and that the host-env and
host-file canaries are not visible. It contains no network code.

The argument: network egress, loopback, LAN and metadata blocking are enforced outside the VM, by
QEMU on the host, and inside the VM by the container runtime (`--network none`). Neither layer
depends on the attacker's language; a socket opened from Python meets the same slirp and network
namespace as one opened from Node. The witness proves that pip's lifecycle hooks run behind that
same boundary (same container profile, same uid, no capabilities). **Residual gap:** there is no
Python-native network attack in the suite.

## Evaluator and trust model

`src/vm/evidence.ts` runs on the host. Everything a fixture reports about itself is **untrusted
guest output**: a compromised guest can lie, so reports can only make the verdict worse. A
non-denied outcome, a missing category or any malformed report line fails the gate, but a clean
report proves nothing alone. The real gate is what the host measures itself:

- no canary value appears in any byte the guest returned (exec stdout and stderr, files read back
  through the broker), checked raw, as hex (both cases) and as base64 at all three byte
  alignments;
- the planted host listeners accepted zero connections;
- every host-side broker-abuse request was rejected before reaching the guest.

Report fields are validated before use (known categories, short plain-text attempts and outcomes);
anything else counts as a malformed report.

`assertBoundaryHeld` throws `BoundaryBreachError` on any violation; the gate suite calls it.
Making it a precondition of shipping authorization for a run is follow-up work (S2–S5).

## Teardown and kill switch (scenario 20)

`destroy` is one attempt: SIGTERM then SIGKILL, only after the process start token matches the
recorded one (a recycled PID is never signalled), then the overlay and socket are removed.
`teardownVm` retries up to three times; on exhaustion the run transitions to `blocked_cleanup`
with leftover PIDs and disk paths journaled, and the blocked run is handed to `observeRun`
(e.g. `IntentDriver.observeRun`) so the admission fence sees it. `assertPublicationPermitted`
delegates to the intent admission table, which admits no GitHub write in `blocked_cleanup`, and
`blocked_cleanup` has no edge back to execution or shipping. A failed create still journals what
its cleanup left behind. The incident kill switch writes an admission-blocking marker first, then
destroys every VM; it needs only the state directory (no QEMU, no current profile), reports VM
directories without a trustworthy record as failures, and `create` re-checks the marker after
QEMU starts and after the guest answers, so a VM booting during an incident is also stopped.
QEMU's own stderr for each VM is kept under `<stateDir>/diagnostics/`.

## Authority boundary (scenario 5)

`src/authority.ts`: model output can only propose one of a closed set of actions (`worker_exec`,
`worker_write_file`, `request_publication`, `hand_off`). Any extra field (target, repo, base,
token, network, budget) is rejected as an override attempt; publication targets and the
candidate SHA come from the controller binding, never from the proposal; secret-shaped argv,
written file content, publication titles and bodies, and hand-off reasons are rejected; there is
no action that reads secrets. A stub model that fully complies with an
injected "reveal credentials / retarget the PR" instruction is rejected in every case, and a
retargeted intent fails `authorizeShipping`.

## CI

`.github/workflows/zero-trust-vm.yml` runs on every pull request touching
`packages/zero-trust/**` (and the workflow file), and on manual `workflow_dispatch`:

- **KVM job:** udev rule granting the runner user `/dev/kvm`, QEMU from the Ubuntu archive, bake
  (or restore the cached profile keyed by every profile-digest input), KVM smoke, then the hostile
  suite (`src/__tests__/vm-gate.e2e.test.ts`, `ZT_VM_E2E=1`), which plants the canaries, runs both
  fixtures in the VM and calls `assertBoundaryHeld`. Evidence JSON is uploaded and summarized.
- **TCG job:** no udev rule, so `/dev/kvm` stays closed; smoke test on the same cached image with
  `--accel tcg`.
- No repository secrets reach either job: `permissions: contents: read`, no `secrets.*`
  references, no environment derived from secrets, `persist-credentials: false`,
  `pull_request`/`workflow_dispatch` only (never `pull_request_target`), actions pinned by commit
  SHA. `scripts/zero-trust-vm-workflow.test.mjs` enforces each of these and fails if a secret,
  token expression, wider permission or unpinned action is added.
- Guest output reaches the job log, so the suite runs between `::stop-commands::` markers and
  the step summary renders guest-derived text inside code blocks.

## Residual risks

- **Hypervisor and kernel exploits** (QEMU device emulation, slirp, KVM, guest kernel) are out of
  scope for proof (PRD §9). Mitigations: minimal device set, QEMU seccomp sandbox, unprivileged
  QEMU, no shared folders.
- **Untrusted guest reports.** The fixtures' self-reports can be forged by a compromised guest;
  only the host-measured checks are relied on. A guest that stays silent produces "missing
  coverage", which fails closed.
- **Exact-match canary detection.** Leaks are detected raw, hex and base64 only. URL-safe base64,
  compression, splitting, encryption or a covert channel (timing, output length) would not be
  detected by the canary scan. The listener and network checks do not depend on this.
- **No Python-native network attack** (pip witness gap, above).
- **Socket path length.** UNIX socket paths are limited to 107 bytes; the broker socket lives in a
  short private runtime directory, and an over-length path fails closed
  (`socket_path_too_long`) rather than being truncated.
- **`-daemonize` with seccomp.** `-daemonize` cannot be combined with `-sandbox spawn=deny`, so
  the controller detaches QEMU itself (own session, recorded spawn PID, start-token check). A controller crash
  leaves QEMU running until the kill switch or the next teardown reconciles it.
- **Bake supply chain.** Distro packages and the container base come from the Ubuntu archive and
  the Microsoft registry (apt signatures, image digest); the resulting image is hash-pinned, but
  the bake itself trusts those sources. In CI the baked image is shared through the Actions cache
  of the same repository; a pull request can only write cache entries scoped to its own ref. The
  manifest check is integrity, not authentication: whoever can write the profile directory can
  supply a different image, so it must stay private to the controller's user.
- **slirp `restrict=on` semantics** are measured by the suite on the pinned QEMU version, not
  assumed; a QEMU upgrade must re-run the gate.
- **Disk size.** A run overlay cannot be smaller than the 16 GiB baked disk (the guest kernel
  rejects the partition table and finds no root), so smaller limits are refused. Space beyond
  16 GiB is not usable until the root partition is grown, which run VMs do not do yet.
- **Diagnostic boot in CI.** When the KVM job fails, `zt-vm.mjs diagnose` boots the baked image
  once more with the run-VM arguments plus a serial log, so a boot failure is visible. No fixture
  code runs in that boot.
- **Kill switch release.** Nothing lifts the kill switch; an operator deletes
  `<stateDir>/KILL_SWITCH` after the incident. The refusal names that file.
- **Receipt schema.** Adding the required `profile.accelerator` moved receipts to
  `ztfc-receipt-v2`; v1 receipts no longer verify (the package is private and receipts expire
  after 15 minutes).
- **Linux x86_64 hosts only.** macOS (Virtualization.framework) and Windows (WSL2) refuse with
  `unsupported_os` until their profiles exist.
