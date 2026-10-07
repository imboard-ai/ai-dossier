# Decision record: package proxy and ecosystem support (feasibility gate 2)

- **Status:** **GO** for npm, pip (hash-pinned) and uv, within the supported set below. The
  VM-independent parts were prepared in #1059; the in-VM proof and this verdict are #1010.
- **Spec:** [PRD](../prd.md) §5.5, §5.6, §9 feasibility gate 2; scenarios 6 and 7.
- **Code:** `packages/zero-trust/src/ecosystem/`, `src/vm/provision-channel.ts`, the
  provisioning phase in `src/vm/local-qemu.ts` and `vm-guest/agent.py`, the host stack in
  `scripts/zt-proxy.mjs` and `proxy/zt_proxpi.py`; the production evidence runner in
  `src/controller/evidence-runner.ts` (#1095). Proof: `src/__tests__/vm-proxy.e2e.test.ts`,
  which drives that runner.
  Fixtures: `packages/zero-trust/fixtures/ecosystem/`.
- **Builds on:** [execution-profile record](execution-profile.md) (#1009, gate 1).

## Context

Gate 2 must show that representative npm, pip (hash-pinned) and uv projects can be
provisioned through a constrained package proxy and then build and test with no network.
Provisioning is not air-gapped: it reaches public registries, but only through a proxy
that admits package downloads and nothing else (§5.5).

Decisions 1–6 cover what is supported, how a runtime is chosen, which commands run in
which network phase, how results are classified, and which proxy components enforce which
rules. Decision 7 covers how the VM reaches the proxy. The evidence section is the in-VM
run under KVM in CI, and the last sections settle the questions #1059 left open.

## Decision 1: proxy components

| Role | Choice | Why |
|---|---|---|
| npm mirror | **Verdaccio** | Mature, widely used, MIT licensed. Works as a caching proxy for one uplink. Publishing (`$nobody`), the web UI and auth can be switched off. npm's default `replace-registry-host=npmjs` rewrites `registry.npmjs.org` URLs in `package-lock.json` to the configured registry, so `npm ci` works unchanged. |
| PyPI mirror | **proxpi** over devpi | proxpi is a small caching proxy for the simple index that also downloads and serves the files, configured only through environment variables. devpi is a full index server with users, uploads and a database. That surface is not needed for a read-only mirror. |
| Egress enforcement | **Squid** forward proxy | Standard OSS forward proxy. Its ACLs cover method, scheme, port, host, URL path, request body, destination IP after its own DNS resolution, response status and `Location` header, and body size. |

Topology. Everything right of the VM runs on the controller host, outside the VM:

```
VM (no egress)                              │ controller host
worker container ─(internal net)─> relay ───┼─< hostfwd <─ connector ──> one mirror (Verdaccio | proxpi)
                                            │                               │ internal Docker network
                                            │                               └──> Squid ──(HTTPS)──> registry.npmjs.org
                                            │                                                       pypi.org, files.pythonhosted.org
```

- In the provisioning phase the worker reaches only the run's one mirror (Verdaccio for
  npm, proxpi for pip and uv). In the build and test phase it reaches nothing.
- The mirrors share an `--internal` Docker network with Squid; only Squid also joins an
  egress network, so a mirror has no route anywhere except Squid.
- Only the mirrors may use Squid (`acl mirrors src`). Squid admits only `CONNECT` to the
  three registry hosts on 443. It then inspects the TLS (peek, stare, then `ssl-bump`) so
  path rules apply inside the tunnel. The inspection CA is generated per run; the mirror
  containers trust it (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`), the worker never sees it.
- Squid builds from the Ubuntu archive's `squid-openssl` on a digest-pinned Ubuntu base;
  Verdaccio and proxpi run from digest-pinned images (`scripts/zt-proxy.mjs`).
- proxpi must run with `PROXPI_DOWNLOAD_TIMEOUT` raised (we set 600 s). With its default of
  0.9 s, proxpi answers a slow download by **redirecting the client to the upstream file
  URL**, which would send the worker straight to `files.pythonhosted.org`.
- proxpi asks PyPI for `/simple/<name>` without the trailing slash, which PyPI answers with
  a redirect. `proxy/zt_proxpi.py` appends the slash before the request leaves (ten lines,
  no other change), so the policy stays at zero redirects instead of being widened.

## Decision 2: the policy model

The policy is typed data (`PROXY_POLICY`, `ztfc-proxy-policy-v1`). The same pattern text
drives the TypeScript reference evaluator used in unit tests and the generated Squid
`urlpath_regex` ACLs, so the two cannot drift. Registry addresses come from one module
(`registries.ts`) shared with detection and the rendered mirror configs.

| Rule | Admitted | Enforced in Squid by |
|---|---|---|
| Methods | `GET`, `HEAD` | `package_methods` on every allow line |
| Scheme and port | `https` on 443 only | `deny !https_proto`; `https_proto tls_port` on every allow line |
| Request body | none | `deny has_body` (`Content-Length` ≥ 1) and `deny chunked_body` (`Transfer-Encoding`) |
| URL | no credentials, no query or fragment | path ACLs are anchored and admit no `?` |
| `registry.npmjs.org` | Package document (`/name`, `/@scope%2fname`, `/@scope/name`) and tarball (`/[@scope/]name/-/name-<version>.tgz`) | `dstdomain -n` + `urlpath_regex` |
| `pypi.org` | `/simple/<project>/` only. Not the root index, the JSON API, upload or account paths | same |
| `files.pythonhosted.org` | `/packages/xx/yy/<60 hex>/<file>.(whl\|tar.gz\|zip)[.metadata]` | same |
| Redirects | **none** (`maxRedirects: 0`) | `http_reply_access deny redirect_status` (every 3xx except 304 Not Modified, the answer to a mirror's conditional request) |
| Destinations | no IP literals (IPv4 or IPv6); no private, loopback, link-local (including metadata), CGNAT, multicast, IPv4-mapped, NAT64 or 6to4 ranges, checked after Squid's own DNS resolution | `deny ip_literal`, `deny forbidden_dst` |
| Size | Response body capped at 256 MiB | `reply_body_max_size` |

**Redirects.** Squid sees each hop as an unrelated request, so the only hop limit it can
enforce is zero. Registry documents and artifacts are served at canonical URLs that the
mirrors request directly, so the policy follows no redirect at all. The evaluator still
judges a redirect's destination first, so an off-registry `Location` is reported as
`redirect_off_registry`. A policy with a hop budget renders a `Location`-host check
instead, and the hop count is then left to the mirrors' HTTP clients.

**Lockfile hashes.** Expected digests come from the lockfile, never from the registry
(`buildLockIndex`): npm `integrity` (sha512), pip `--hash` (sha256, keyed by name and
version because pip lockfiles carry no file names), uv `hash` per artifact URL. The index
validates every entry itself and fails with a coded `LockIndexError`. `checkArtifact`
rejects an artifact that is not in the lockfile or whose bytes do not match, and denies
malformed URLs. The package managers verify hashes too (`npm ci`, `pip --require-hashes`,
`uv pip install --require-hashes`). The controller-side check is defense in depth, and it
is the hook for auditing the mirror caches after provisioning.

Unit tests cover the three rejection cases from the issue: a non-package request to an
allowlisted host, a redirect off the registry, and a lockfile hash mismatch
(`proxy.test.ts`). The in-VM run repeats them against the real proxy (Evidence).

**TLS inspection mode.** Squid peeks at the client hello, stares at the server
certificate, then bumps. Bumping at the first step generates a bare certificate with no
Authority Key Identifier, and Python 3.13+ (proxpi's runtime) rejects it under strict
verification. Staring lets Squid mimic the origin certificate, which carries one. Staring
means Squid completes a TLS handshake with an allowlisted registry host before it sees the
request inside the tunnel; a request the path rules refuse then fetches nothing. A
`CONNECT` to any other host is logged `TCP_DENIED`; Squid bumps it only to deliver its
error page.

## Decision 3: supported ecosystems (MVP)

| Supported | Requirement |
|---|---|
| npm | `package.json` + `package-lock.json` v2/v3. Every fetched package resolved from `registry.npmjs.org` with sha512 integrity. Only a package bundled inside another package (nested `inBundle` with no `resolved`) is exempt; workspace links are not supported. `packageManager`, if set, is `npm@x.y.z`. A real `scripts.test` |
| pip | Root `requirements.txt` where every line is `name==version` with at least one `--hash=sha256:`. Only `--require-hashes` is allowed as an option. Lines are split and joined exactly as pip does (Python's line boundaries; a comment line never continues), so the file detection approves is the file pip applies. No `${VAR}` expansion. pytest is in the lock |
| uv | `pyproject.toml` + `uv.lock` version 1, a **virtual** project (`[tool.uv] package = false`). Every non-root package from PyPI with a sha256 per artifact, each artifact URL a PyPI file of that package and version, and at least one wheel. pytest is in the lock |

Everything else gives `unsupported_environment` with a specific reason: no ecosystem,
Node and Python together, both `uv.lock` and `requirements.txt` (`ambiguous_manager`),
pnpm, Yarn, bun, npm-shrinkwrap, Poetry, Pipenv, PDM or a non-npm `packageManager`
(`unsupported_manager`), repository tool config that could redirect fetches (`.npmrc`,
`.yarnrc`, `pip.conf`, `pip.ini`, `uv.toml`, `[tool.uv]` keys other than `package` and
`default-groups`: `unsupported_config`), a missing manifest or lockfile, lockfile v1 or an
unknown uv lock version, git/URL/path/link dependencies, missing hashes, a uv package with
no wheel (`binary_unavailable`), a uv project that installs itself (`editable = "."`:
`project_build_required`, because building it runs the repository's build backend, which
must not happen while the proxy is reachable), unpinned requirements, include or index
options in `requirements.txt`, and no test runner. Detection reads root-level files only.

The `detail` on an unsupported outcome is a bounded identifier (a file, field, option or
package name, at most 214 characters from a narrow alphabet, secret-scanned). Repository
text outside that (URLs, credentials, control characters) is dropped, never echoed.

## Decision 4: runtime profiles

`profiles.json` (`ztfc-profiles-v1`, manifest `2026.10.1`) lists Node 20 and 22 and
Python 3.11, 3.12 and 3.13. Each entry pins its upstream `mcr.microsoft.com/devcontainers`
image by digest (resolved on 2026-10-06). Its `workerHardening` section names the
hardening recipe (`ztfc-worker-hardening-v1`: sudo purged, every setuid/setgid bit
stripped, `USER 1000:1000`), uv pinned by digest (`ghcr.io/astral-sh/uv` 0.12.5), and the
profiles the VM image carries: `node-22` and `python-3.13`.

The VM bake builds the hardened worker images FROM those digests (`src/vm/cloud-init.ts`,
pins derived from `profiles.json` in `src/vm/profile.ts`). Docker builds are not
reproducible byte for byte, so the derived image is identified by its inputs (base
digest, recipe, uv digest), and each bake records the resulting image IDs in the VM
manifest (`containerImages`, `workerProfiles`); the evidence file of every run lists
them. A selected profile the VM image does not carry is `unsupported_environment`
(`profile_not_baked`), never another image.

Selection takes the newest profile that satisfies **every** project declaration
(`engines.node`, `.nvmrc`, `.node-version`; `requires-python` in `pyproject.toml` and
`uv.lock`, `.python-version`). Missing, unparseable, unsupported or mutually exclusive
declarations, or a manager no profile supports, give `unsupported_environment`
(`runtime_unspecified`, `runtime_declaration_invalid`, `runtime_version_unsupported`,
`runtime_conflict`, `manager_unsupported`). A version is never substituted: `.nvmrc`
`20.11.0` is unsupported when the profile ships 20.19.2. The PRD says a missing
requirement "hands off". We record that as an explicit unsupported outcome with a
reason, which the user sees, rather than guessing.

Python specifiers are matched by a deliberately narrow PEP 440 subset (`X[.Y[.Z]]` with
`== != <= >= < > ~=` and `.*`). Anything else is invalid, not approximated.

The selection is written once per run to controller storage (`<runId>.profile.json`,
mode 0600). The write is linked into place with `link(2)`, so two racing writers cannot
both win: an identical record is idempotent, a different one is `record_mismatch`, and
storage errors propagate. Before execution the record is reloaded, schema-validated and
checked against the current manifest (`record_missing`, `invalid_record`,
`manifest_changed`, `profile_changed`). `profileReceiptBinding` supplies the receipt's
`profileDigest` and `profile` fields.

## Decision 5: command plans and network phases

Plans are argv data tagged `package_proxy` (provisioning) or `none` (verification). The
product never executes them. No repository code runs while a network path exists:

| Manager | Provisioning (proxy only) | Verification (no network) |
|---|---|---|
| npm | `npm ci --ignore-scripts --no-fund` | `npm rebuild` (runs install scripts offline), `npm test [-- targets]` |
| pip | `<python> -I -m venv --clear <env>`; `<env>/bin/python -I -m pip install --require-hashes --no-deps --only-binary=:all: -r requirements.txt` | `<env>/bin/python -m pytest [targets]` |
| uv | `uv export --frozen --offline --no-config --no-python-downloads --format requirements.txt --no-emit-project --no-header --output-file <export>`; `uv venv … --python <python> <env>`; `uv pip install … --python <env>/bin/python --require-hashes --no-deps --only-binary :all: --index-url <mirror> -r <export>` | `uv run --frozen --no-config --no-python-downloads --python <python> --offline --no-sync pytest [targets]` |

**Why not `uv sync --frozen`.** It downloads the artifact URLs recorded in `uv.lock`
(`files.pythonhosted.org`) and ignores the configured index: with `UV_DEFAULT_INDEX`
pointing at a logging listener and `HTTPS_PROXY` at another, uv 0.12.5 sent only
`CONNECT files.pythonhosted.org:443` and nothing to the index. In the VM it simply fails,
because there is no route to that host (Evidence), so it cannot bypass the proxy, but it
also cannot provision. The lock is therefore exported offline to hashed requirements
outside the repository and installed from the mirror; the hashes still come from
`uv.lock`, and `--require-hashes` enforces them.

- `<python>` is the profile image's interpreter (default `/usr/local/bin/python`), `<env>`
  an environment directory outside the repository (default `/opt/ztfc/env`; uv gets it as
  `UV_PROJECT_ENVIRONMENT`) and `<export>` the exported requirements (default
  `/opt/ztfc/uv-requirements.txt`). In the VM, `/opt/ztfc` is a worker-writable mount
  outside the workspace that persists across the phase switch. pip gets
  `PIP_TRUSTED_HOST` when the mirror is plain HTTP; integrity comes from
  `--require-hashes`. With `-I` the interpreter ignores the working directory and
  `PYTHON*` variables, so a committed `venv.py`, `pip.py`, `.venv` or `.pth` file
  cannot run during provisioning. `PIP_CONFIG_FILE=/dev/null` and `uv --no-config` ignore
  repository configuration.
- `--only-binary` (pip, uv) and `UV_NO_BUILD=1` mean no sdist build (arbitrary code) runs during
  provisioning. Detection rejects uv packages with no wheel (`binary_unavailable`). pip
  locks do not say which files exist, so for pip a sdist-only dependency fails
  provisioning, and `applyProvisioning` turns any provisioning failure into
  `unsupported_environment` (§5.5), never a repair or a broader network.
- Verification commands also get offline environment settings (`npm_config_offline`,
  `PIP_NO_INDEX`, `UV_OFFLINE`, empty proxy variables). These are belt and braces; the
  real guarantee is the VM's network policy.
- Test commands (`captureReport`) write junit to `/ztfc/report/report.xml`: Node's test
  runner takes the reporter from `NODE_OPTIONS` whatever `scripts.test` says, pytest from
  `PYTEST_ADDOPTS`. See "Report capture" below.

## Decision 6: result classification and the repair cap

- A command is `passed` only when it exits 0 **and** the supervisor read a report with at
  least one suite, and `failed` only when it exits non-zero with such a report. Since #1095 the report's case counts must also agree with the exit
  status: exit 0 with a failing case or with no executed case, or a non-zero exit with no
  failing case, is `inconclusive` (a hook that forces the exit status is not a result). A timeout,
  a signal, a missing or unreadable report, or zero or unknown suites is `inconclusive`,
  never a pass: a crashed or misconfigured runner is not a test result. Invalid suite
  counts are recorded as `unknown` in receipt evidence.
- Regression proof (scenario 6): base `failed` plus candidate `passed` is
  `reproduced_and_fixed`. A base that passes is `not_reproduced` and hands off before
  patching.
- Repair cap (scenario 7): `applyVerification` moves a `verifying` run to `shipping`,
  to `implementing` while fewer than two repairs were used in the session, otherwise to
  `failed` (`execution_failed`). The count comes from the run's immutable history
  (`repair_required` events since the last `plan_approved` or `revision_requested`), so
  it survives restarts. `assertRepairAllowed` refuses a third repair. The lifecycle
  table itself does not count repairs, so the controller must route verification
  verdicts through `applyVerification`.

## Decision 7: how the VM reaches the proxy

The VM has no egress (#1009: slirp `restrict=on`). The provisioning phase adds exactly one
forward, and the build/test phase has none.

- **The forward is a `hostfwd`, not a `guestfwd`.** In QEMU 8.2 a `guestfwd` targets either
  one chardev, a single byte stream that every guest connection to that address shares,
  or `cmd:`, which spawns a process per connection and is forbidden by
  `-sandbox spawn=deny`. Package managers open many parallel connections, so neither
  works. Instead the provisioning VM gets
  `hostfwd=tcp:127.0.0.1:<free port>-:7480`: the host can connect *into* the guest, and the
  guest still cannot open any connection out (`restrict=on` is unchanged).
- **Connector and relay.** The controller's `ProvisionChannel` keeps a small pool of
  connections dialed in through the forward, each opening with a per-boot relay key that
  the controller hands the guest in its broker hello (never on a command line). The guest
  agent's relay (root in the VM, started only in the provisioning phase and container
  scope) accepts host connections only from slirp's host address and only with that key,
  so another process on host loopback cannot stand in for the connector; it pairs each
  with a worker connection. When the guest sends the first bytes,
  the connector opens a connection to the run's one mirror and splices the two. It never
  parses bytes, and it has no other destination: the mirror's IPv4 literal is fixed
  when the VM is created.
- **Worker network.** A provisioning command (`exec({ network: 'package_proxy' })`) runs
  in the hardened container on an `--internal` Docker network inside the VM whose only
  listener is the relay at its gateway (`172.30.255.1:7481`). Every other command keeps
  `--network none`. `package_proxy` is refused outside provisioning by the controller
  before anything reaches the guest, and again by the guest.
- **Phase switch.** `endProvisioning` closes the connector (journaling what it carried),
  asks the guest to sync and power off (its answer is not trusted), waits for QEMU to exit
  and kills it otherwise (journaling which), then starts QEMU again on the same overlay
  disk with the forward-free arguments. Nothing the guest does can keep or add a forward:
  the new process's arguments are controller policy. The phase travels as a second SMBIOS
  OEM string and the guest announces it in its hello. A mismatch fails the VM: on create it
  is destroyed; on a phase switch the relaunched QEMU is killed, `endProvisioning` throws
  and journals `vm_phase_change_failed`, and the caller destroys the VM. One switch per VM
  runs at a time. The switch costs one guest boot (10–11 s under KVM, see Timings). A
  connector whose QEMU dies unexpectedly closes with it.
- **Rejected alternatives.** A multiplexing protocol over the one `guestfwd` chardev or the
  broker port (custom framing the host would have to parse from an untrusted guest);
  `passt` or `slirp4netns` in a network namespace (more moving parts and host
  privileges); handing the VM a read-only disk of pre-fetched packages (stronger, but not
  the proxied provisioning the PRD and #1009 specify, and it moves resolution to the host).

## Report capture

The supervisor gives each test command a fresh, empty report directory outside the
workspace (`/ztfc/report`, created by the guest agent per command), then reads
`report.xml` back itself (`O_NOFOLLOW`, regular file, at most 256 KiB) and returns it in
the broker reply; the host parses it (`parseJunitReport`, bounded, no DTDs) into the suite
count. A repository cannot pre-seed the report (the directory is outside the tree and
recreated per command). Code that runs as the test can still write the report, as it can
choose its own exit status: the report is evidence about a run, not a sandbox boundary. A
runner that ignores `NODE_OPTIONS`/`PYTEST_ADDOPTS` writes nothing, which is
`inconclusive`, never a pass.

## Fixtures

Three fixtures (npm, pip, uv), each with a documented bug, a regression patch that fails
on the base and a fix patch that passes; see the fixtures README. The
`Zero-trust fixtures` workflow self-checks them on the CI runner against the public
registries, requiring the runner's Node and Python to match the selected profiles; that
is the only host-side execution, and it proves the fixtures and plans, not isolation. The
isolated proof is below.

## Evidence

CI run [37532883190](https://github.com/imboard-ai/ai-dossier/actions/runs/37532883190)
(GitHub-hosted `ubuntu-24.04`, the code in this record), job "Package proxy proof (KVM)",
artifact `zero-trust-proxy-evidence-kvm` (evidence JSON, policy checks, Squid access log,
mirror logs, QEMU stderr per VM and phase). Earlier runs
[37520527415](https://github.com/imboard-ai/ai-dossier/actions/runs/37520527415) and
[37524097751](https://github.com/imboard-ai/ai-dossier/actions/runs/37524097751) gave the
same results before the review fixes (the first failed only on the test's own receipt
construction). One intermediate run failed: after the review moved the guest relay's
start off the hello path, the controller could dial in before the relay listened, and
those connections never reached it; the agent now answers the hello only once the relay
is up, and the connector replaces idle connections after 30 s. The gate 1 hostile suite
passed again on the rebaked image in every run.

**AC1 — provision via the proxy, test offline, exact commits.** Per fixture, three Git
commits (base, base + regression test, + fix). Per commit, a fresh VM provisions the
exact tree (every blob of `git ls-tree` uploaded, the tree id recorded) through the
proxy, switches phase, and runs the tests with no network:

| Fixture | Provisioning (exit) | Base suite | Regression test on base | Regression test on fix | Suite on fix | Verdict |
|---|---|---|---|---|---|---|
| npm | `npm ci --ignore-scripts --no-fund` (0); `npm rebuild` offline (0) | passed (exit 0, 1 suite) | **failed** (exit 1, 1 failure) | passed (exit 0) | passed (exit 0) | `reproduced_and_fixed` |
| pip | `python -I -m venv` (0); `pip install --require-hashes --no-deps --only-binary=:all:` (0) | passed | **failed** (exit 1) | passed | passed | `reproduced_and_fixed` |
| uv | `uv export --frozen --offline` (0); `uv venv` (0); `uv pip install --require-hashes …` (0) | passed | **failed** (exit 1) | passed | passed | `reproduced_and_fixed` |

Each candidate gets a `ztfc-receipt-v2` receipt (#1008) signed by an ephemeral key, with
the two supervised test commands as evidence and `verified: true`.

**AC2 — the proxy refuses.** Ordinary requests from a client standing where a mirror
stands (`zt-proxy.mjs check`), judged from Squid's own access log, all as required:
allowed package document and simple index (200); denied: a non-package path on an
allowlisted host (`/-/whoami`, `/pypi/pytest/json`, the root `/simple/`), a query string,
a request body (`POST`), plain HTTP, an **on-registry redirect** (`/simple/PyTest/` → 301,
logged `TCP_DENIED_REPLY`), an **off-registry host** (`example.com`), an IP literal, the
metadata address, and any request from a non-mirror address. An off-registry redirect is
refused twice over: every 3xx reply is denied, and its target host is not admitted.
**Lockfile hash mismatch:** with one digest flipped in each lockfile, provisioning fails
in the VM (`npm ci` EINTEGRITY; `pip install` and `uv pip install` hash errors),
`applyProvisioning` moves the run to `unsupported_environment`, and `checkArtifact` flags
the cached bytes as `hash_mismatch` against the tampered lock.

**AC3 — unsupported setups.** Unpinned `requirements.txt` → `unpinned_requirement`
(`pytest`); pnpm and Yarn → `unsupported_manager`; all `unsupported_environment`.

**AC4 — inconclusive and the repair cap.** In the VM: a test that times out, a test run
that writes no report, and an unreadable report each classify `inconclusive` (exit 0 in
the last two). Fed to `applyVerification`, three inconclusive verdicts give
`implementing`, `implementing`, `failed`.

**Boundary.** The #1009 hostile probe (reused unchanged) ran in the worker container on
the provisioning network with the forward live, in the same VM after the phase switch,
and as root on the VM's network stack with the forward live (host-enforced categories).
Boundary held: 0 violations over 90 judged attempts (every category covered), 0
connections on the planted host listeners, no canary in any guest byte, and all 12
host-side checks (`package_proxy` after the phase switch) rejected before the guest.
The mirror stayed reachable during provisioning (an ordinary fetch through the relay
succeeded).

**Squid audit.** Every request the mirrors sent upstream during the run was admitted by
the policy evaluator, none was denied, and none was a redirect; the hosts were exactly
`registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`.

## Settled: the questions #1059 left open

1. **uv `--frozen` and the mirror.** Confirmed: it fetches lockfile URLs directly and ignores
   the index. In the VM it fails (no route; uv names `files.pythonhosted.org` in its error),
   so it cannot bypass the proxy. Provisioning uses the offline export instead (Decision 5).
2. **ssl-bump and CA trust.** Squid (`squid-openssl` 6.14) inspects TLS with a per-run CA;
   only the mirror containers trust it. It runs on the host, not in the VM: the VM's only
   path is the relay to one mirror. Bump mode: peek, stare, bump (Decision 2).
3. **Verdaccio uplink.** Verdaccio's upstream requests appear in Squid's log from its
   address, and it has no other route (internal network); npm fetched tarballs from
   Verdaccio (lockfile URLs rewritten by `replace-registry-host`).
4. **No redirects.** Registries served every mirror request without a redirect once
   proxpi asks for canonical index URLs (`zt_proxpi.py`). Squid's audit shows zero 3xx.
5. **Report capture.** Supervisor-owned report directory, read back by the agent (above).
6. **Hardened images.** Built from the `profiles.json` digests, manifest `2026.10.1`;
   image IDs recorded per bake (Decision 4).
7. **Cache audit.** `checkArtifact` over every cached tarball and wheel against the
   fixtures' lockfiles: all admitted, none rejected.
8. **Escape attempts.** Direct DNS, direct egress, IP literals, metadata, the host gateway
   and loopback, and the LAN: all denied from the worker with the forward live and after
   it; IP literals and redirect chains refused by Squid (AC2).

## Timings and the TCG timeout scale

Three CI runs ([37520527415](https://github.com/imboard-ai/ai-dossier/actions/runs/37520527415), [37524097751](https://github.com/imboard-ai/ai-dossier/actions/runs/37524097751), [37532883190](https://github.com/imboard-ai/ai-dossier/actions/runs/37532883190)), GitHub-hosted `ubuntu-24.04`; runner hardware varies
between jobs. KVM: VM boot 7.4–9.9 s (12–16 s for the first VM of a job), provisioning
0.9–1.5 s (npm), 4.0–5.5 s (pip, mostly `venv`), 1.2–1.6 s (uv), phase switch 8.1–11 s,
offline tests 0.4–1.2 s; the proxy stack starts in about 30 s. TCG ran the npm fixture
(job "Package proxy timings (TCG)"). The table compares the same npm steps, with each
ratio taken between the KVM and TCG jobs of the same run:

| Step | KVM | TCG | TCG / KVM |
|---|---|---|---|
| VM boot | 7.8–9.9 s | 88–107 s | 9.8–12.6× |
| Phase switch (power off, relaunch, hello) | 8.3–10.8 s | 108–128 s | 10.0–15.1× |
| `npm ci` through the proxy | 0.92–1.47 s | 14.1–18.5 s | 10.1–16.9× |
| `npm rebuild` | 0.82–1.17 s | 11.8–14.5 s | 10.3–16.0× |
| `npm test` | 0.37–0.57 s | 6.4–7.9 s | 11.3–19.4× |

With #1009's 8.8–15× for short container commands, the old ×4 command-timeout scale was
too small: a command needing more than a quarter of its budget under KVM would time out
under TCG and come back `inconclusive`. `TIMEOUT_SCALE.tcg` is now 16. The ratio that
matters is the one for long commands, since only a command near its budget can time out:
multi-second steps (boot, phase switch) measured 10–15×, so 16 covers them. Sub-second
commands reached 19× (fixed container start-up dominates them), far inside their budgets.
16 is also the largest scale that keeps the 20-minute default command budget under the
broker's 6-hour exec cap. It scales command, broker and shutdown clocks; the TCG boot
timeout (20 min) already had headroom.

## Gate 2 verdict

**GO.** npm (`package-lock.json`), pip (`--require-hashes`) and uv (`uv.lock`, virtual
projects) provision through the constrained proxy inside the VM and verify offline against
exact commits, with the proxy's rejections and the VM boundary observed under real egress
enforcement. Unsupported cases are explicit `unsupported_environment` outcomes, not
fallbacks: uv projects that install themselves (`project_build_required`), runtimes the
VM image does not carry (`profile_not_baked`; today `node-22` and `python-3.13` only), and
everything in Decision 3.

## Residual risks

- **Loopback forward port.** The `hostfwd` listens on host `127.0.0.1`, so another local
  process on the controller host can connect into the guest during provisioning. The relay
  drops any connection that does not open with the per-boot relay key, so such a process
  cannot take the mirror's place, and the relay's pool and worker counts are capped. It can
  still hold relay threads open until its 10 s key timeout; the controller host is assumed
  single-user.
- **Mirror content.** The mirrors serve what the registries serve. Integrity rests on the
  lockfile hashes (checked by the package managers and audited by `checkArtifact`), not on
  the mirror.
- **Repository-controlled reports.** Test code can write its own junit report, as it can
  choose its exit status (Report capture).
- **proxpi shim.** `zt_proxpi.py` patches one method of proxpi; a proxpi upgrade must
  re-run this proof (the image is digest-pinned).
- **Squid from the archive.** `squid-openssl` comes from the Ubuntu archive at build time
  (apt signatures); the base image is digest-pinned, the package version is recorded in
  the endpoints file.
- **Disk.** The two devcontainer-based worker images take about 4.5 GB of the 16 GiB baked
  disk; larger dependency trees will need the root partition grown (#1009 residual).
