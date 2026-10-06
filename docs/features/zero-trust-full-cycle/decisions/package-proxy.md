# Decision record: package proxy and ecosystem support (draft)

- **Status:** Draft. Prepared in #1059. The in-VM proof and the gate 2 decision belong to #1010.
- **Spec:** [PRD](../prd.md) §5.5, §5.6, §9 feasibility gate 2; scenarios 6 and 7.
- **Code:** `packages/zero-trust/src/ecosystem/`. Fixtures: `packages/zero-trust/fixtures/ecosystem/`.

## Context

Gate 2 must show that representative npm, pip (hash-pinned) and uv projects can be
provisioned through a constrained package proxy and then build and test with no network.
Provisioning is not air-gapped: it reaches public registries, but only through a proxy
that admits package downloads and nothing else (§5.5).

This record covers the parts that do not need a VM: what is supported, how a runtime
is chosen, which commands run in which network phase, how results are classified, and
which proxy components enforce which rules. It ends with what only the in-VM run can show.

## Decision 1: proxy components

| Role | Choice | Why |
|---|---|---|
| npm mirror | **Verdaccio** | Mature, widely used, MIT licensed. Works as a caching proxy for one uplink. Publishing (`$nobody`), the web UI and auth can be switched off. npm's default `replace-registry-host=npmjs` rewrites `registry.npmjs.org` URLs in `package-lock.json` to the configured registry, so `npm ci` works unchanged. |
| PyPI mirror | **proxpi** over devpi | proxpi is a small caching proxy for the simple index that also downloads and serves the files, configured only through environment variables. devpi is a full index server with users, uploads and a database. That surface is not needed for a read-only mirror. |
| Egress enforcement | **Squid** forward proxy | Standard OSS forward proxy. Its ACLs cover method, scheme, port, host, URL path, request body, destination IP after its own DNS resolution, response status and `Location` header, and body size. |

Topology (the VM boundary and network enforcement are #1009's responsibility):

```
worker ──(isolated net, plain HTTP)──> Verdaccio / proxpi ──> Squid ──(HTTPS)──> registry.npmjs.org
                                                                              pypi.org, files.pythonhosted.org
```

- In the provisioning phase the worker reaches only the two mirrors. In the build and
  test phase it reaches nothing.
- Only the mirrors may use Squid (`acl mirrors src`). Squid admits only `CONNECT` to the
  three registry hosts on 443. It then inspects the TLS (`ssl-bump`) so path rules apply
  inside the tunnel. The inspection CA is trusted by the mirror containers only, never
  by the worker.
- proxpi must run with `PROXPI_DOWNLOAD_TIMEOUT` raised (we set 600 s). With its default of
  0.9 s, proxpi answers a slow download by **redirecting the client to the upstream file
  URL**, which would send the worker straight to `files.pythonhosted.org`.

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
| Redirects | **none** (`maxRedirects: 0`) | `http_reply_access deny redirect_status` |
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
`uv sync --frozen`). The controller-side check is defense in depth, and it is the hook
for auditing the mirror caches after provisioning.

Unit tests cover the three rejection cases from the issue: a non-package request to an
allowlisted host, a redirect off the registry, and a lockfile hash mismatch
(`proxy.test.ts`).

## Decision 3: supported ecosystems (MVP)

| Supported | Requirement |
|---|---|
| npm | `package.json` + `package-lock.json` v2/v3. Every fetched package resolved from `registry.npmjs.org` with sha512 integrity. Only a package bundled inside another package (nested `inBundle` with no `resolved`) is exempt; workspace links are not supported. `packageManager`, if set, is `npm@x.y.z`. A real `scripts.test` |
| pip | Root `requirements.txt` where every line is `name==version` with at least one `--hash=sha256:`. Only `--require-hashes` is allowed as an option. Lines are split and joined exactly as pip does (Python's line boundaries; a comment line never continues), so the file detection approves is the file pip applies. No `${VAR}` expansion. pytest is in the lock |
| uv | `pyproject.toml` + `uv.lock` version 1. Every non-root package from PyPI with a sha256 per artifact, each artifact URL a PyPI file of that package and version, and at least one wheel. pytest is in the lock |

Everything else gives `unsupported_environment` with a specific reason: no ecosystem,
Node and Python together, both `uv.lock` and `requirements.txt` (`ambiguous_manager`),
pnpm, Yarn, bun, npm-shrinkwrap, Poetry, Pipenv, PDM or a non-npm `packageManager`
(`unsupported_manager`), repository tool config that could redirect fetches (`.npmrc`,
`.yarnrc`, `pip.conf`, `pip.ini`, `uv.toml`, `[tool.uv]` keys other than `package` and
`default-groups`: `unsupported_config`), a missing manifest or lockfile, lockfile v1 or an
unknown uv lock version, git/URL/path/link dependencies, missing hashes, a uv package with
no wheel (`binary_unavailable`), unpinned requirements, include or index options in
`requirements.txt`, and no test runner. Detection reads root-level files only.

The `detail` on an unsupported outcome is a bounded identifier (a file, field, option or
package name, at most 214 characters from a narrow alphabet, secret-scanned). Repository
text outside that (URLs, credentials, control characters) is dropped, never echoed.

## Decision 4: runtime profiles

`profiles.json` (`ztfc-profiles-v1`, manifest `2026.10.0`) lists Node 20 and 22 and
Python 3.11, 3.12 and 3.13. Each entry pins a container image by digest. For now these
are the upstream `mcr.microsoft.com/devcontainers` base images, resolved on 2026-10-06.
The hardened derivatives the PRD calls for (§5.4) get their own digests in a new
manifest version when #1009/#1010 build them.

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
| uv | `uv sync --frozen --no-config --no-python-downloads --python <python> --no-build` | `uv run --frozen --no-config --no-python-downloads --python <python> --offline --no-sync pytest [targets]` |

- `<python>` is the profile image's interpreter (default `/usr/local/bin/python`) and
  `<env>` an environment directory outside the repository (default `/opt/ztfc/env`; uv gets
  it as `UV_PROJECT_ENVIRONMENT`). With `-I` the interpreter ignores the working directory
  and `PYTHON*` variables, so a committed `venv.py`, `pip.py`, `.venv` or `.pth` file
  cannot run during provisioning. `PIP_CONFIG_FILE=/dev/null` and `uv --no-config` ignore
  repository configuration.
- `--only-binary` and `--no-build` mean no sdist build (arbitrary code) runs during
  provisioning. Detection rejects uv packages with no wheel (`binary_unavailable`). pip
  locks do not say which files exist, so for pip a sdist-only dependency fails
  provisioning, and `applyProvisioning` turns any provisioning failure into
  `unsupported_environment` (§5.5), never a repair or a broader network.
- Verification commands also get offline environment settings (`npm_config_offline`,
  `PIP_NO_INDEX`, `UV_OFFLINE`, empty proxy variables). These are belt and braces; the
  real guarantee is the VM's network policy.

## Decision 6: result classification and the repair cap

- A command is `passed` only when it exits 0 **and** the supervisor read a report with at
  least one suite, and `failed` only when it exits non-zero with such a report. A timeout,
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

## Fixtures

Three fixtures (npm, pip, uv), each with a documented bug, a regression patch that fails
on the base and a fix patch that passes; see the fixtures README. The
`Zero-trust fixtures` workflow self-checks them on the CI runner, using the package's
own command plans against the public registries and requiring the runner's Node and
Python to match the selected profiles. That is the only host-side execution. It proves
the fixtures and the plans, not isolation.

## Open questions for the in-VM run (#1010)

1. **uv and the mirror.** `uv sync --frozen` may download from the artifact URLs
   recorded in `uv.lock` (`files.pythonhosted.org`) and ignore `UV_DEFAULT_INDEX`. If so,
   the worker needs a policy-checked route to the files host: Squid with ssl-bump in
   front of the worker for that one host, or an index-URL rewrite. Measure before choosing.
2. **Squid ssl-bump in the VM image.** It needs `security_file_certgen` and a
   controller-generated CA per run. Confirm that the mirrors trust the CA
   (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`) and that the worker does not.
3. **Verdaccio uplink through Squid.** Confirm Verdaccio honours `https_proxy` for its
   uplink and that tarball URLs in package documents are rewritten to Verdaccio.
4. **No redirects.** Confirm the registries serve every request the mirrors make without a
   redirect (for example proxpi's name normalization). If one is needed, give the policy a
   hop budget and rely on the mirrors' clients for the count.
5. **Report capture.** Classification needs a supervisor-parsed report (suite count).
   Choose the reporter per ecosystem (node `--test-reporter=junit`, pytest `--junitxml`)
   and make sure the report path is outside repository control.
6. **Hardened images.** Build the derived Node and Python profiles (uv installed, no
   sudo, dropped capabilities, interpreter at the planned path). Publish their digests as
   manifest `2026.10.1` or later.
7. **Cache audit.** Run `checkArtifact` over the Verdaccio and proxpi caches after
   provisioning and record the result in the receipt evidence.
8. **Escape attempts.** Exercise direct DNS, direct egress, IP literals, metadata
   addresses and redirect chains from inside the worker against the real proxy.
