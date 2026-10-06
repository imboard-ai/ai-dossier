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
| Egress enforcement | **Squid** forward proxy | Standard OSS forward proxy. Its ACLs cover the whole policy: method, host, URL path, destination IP after its own DNS resolution, response `Location` header and body size. |

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
`urlpath_regex` ACLs, so the two cannot drift.

| Rule | Admitted |
|---|---|
| Methods | `GET`, `HEAD`. No request body |
| URL | `https` only, default port, no credentials, no query or fragment |
| `registry.npmjs.org` | Package document (`/name`, `/@scope%2fname`, `/@scope/name`) and tarball (`/[@scope/]name/-/name-<version>.tgz`) |
| `pypi.org` | `/simple/<project>/` only. Not the root index, the JSON API, upload or account paths |
| `files.pythonhosted.org` | `/packages/xx/yy/<60 hex>/<file>.(whl\|tar.gz\|zip)[.metadata]` |
| Redirects | At most 3 hops. Each `Location` must itself be an admissible request. In Squid: `http_reply_access deny` for 3xx without a registry `Location` |
| Destinations | Squid denies IP-literal hosts and private, loopback, link-local (including metadata), CGNAT and multicast ranges after DNS resolution, so a registry name cannot be rebound to an internal address |
| Size | Response body capped (256 MiB). Request body 0 |

**Lockfile hashes.** Expected digests come from the lockfile, never from the registry
(`buildLockIndex`): npm `integrity` (sha512), pip `--hash` (sha256, keyed by name and
version because pip lockfiles carry no file names), uv `hash` per artifact URL.
`checkArtifact` rejects an artifact that is not in the lockfile or whose bytes do not
match. The package managers verify hashes too (`npm ci`, `pip --require-hashes`,
`uv sync --frozen`). The controller-side check is defense in depth, and it is the hook
for auditing the mirror caches after provisioning.

Unit tests cover the three rejection cases from the issue: a non-package request to an
allowlisted host, a redirect off the registry, and a lockfile hash mismatch
(`proxy.test.ts`).

## Decision 3: supported ecosystems (MVP)

| Supported | Requirement |
|---|---|
| npm | `package.json` + `package-lock.json` v2/v3. Every dependency resolved from `registry.npmjs.org` with sha512 integrity. A real `scripts.test` |
| pip | Root `requirements.txt` where every line is `name==version` with at least one `--hash=sha256:`. Only `--require-hashes` is allowed as an option. pytest is in the lock |
| uv | `pyproject.toml` + `uv.lock` version 1. Every non-root package from PyPI, with a sha256 per artifact. pytest is in the lock |

Everything else gives `unsupported_environment` with a specific reason: no ecosystem,
Node and Python together, more than one Python lock (`ambiguous_manager`), pnpm, Yarn,
bun, npm-shrinkwrap, Poetry, Pipenv, PDM (`unsupported_manager`), a missing lockfile,
lockfile v1 or an unknown uv lock version, git/URL/path dependencies, missing hashes,
unpinned requirements, include or index options in `requirements.txt`, and no test
runner. Detection reads root-level files only.

## Decision 4: runtime profiles

`profiles.json` (`ztfc-profiles-v1`, manifest `2026.10.0`) lists Node 20 and 22 and
Python 3.11, 3.12 and 3.13. Each entry pins a container image by digest. For now these
are the upstream `mcr.microsoft.com/devcontainers` base images, resolved on 2026-10-06.
The hardened derivatives the PRD calls for (§5.4) get their own digests in a new
manifest version when #1009/#1010 build them.

Selection takes the newest profile that satisfies **every** project declaration
(`engines.node`, `.nvmrc`, `.node-version`; `requires-python` in `pyproject.toml` and
`uv.lock`, `.python-version`). Missing, unparseable, unsupported or mutually exclusive
declarations give `unsupported_environment` (`runtime_unspecified`,
`runtime_declaration_invalid`, `runtime_version_unsupported`, `runtime_conflict`). A
version is never substituted: `.nvmrc` `20.11.0` is unsupported when the profile
ships 20.19.2. The PRD says a missing requirement "hands off". We record that as an
explicit unsupported outcome with a reason, which the user sees, rather than guessing.

Python specifiers are matched by a deliberately narrow PEP 440 subset (`X[.Y[.Z]]` with
`== != <= >= < > ~=` and `.*`). Anything else is invalid, not approximated.

The selection is written once per run to controller storage (`<runId>.profile.json`,
mode 0600, atomic, immutable). Before execution it is reloaded and checked against the
current manifest digest and image. `profileReceiptBinding` supplies the receipt's
`profileDigest` and `profile` fields.

## Decision 5: command plans and network phases

Plans are argv data tagged `package_proxy` (provisioning) or `none` (verification). The
product never executes them. Untrusted code never runs while a network path exists:

| Manager | Provisioning (proxy only) | Verification (no network) |
|---|---|---|
| npm | `npm ci --ignore-scripts --no-fund` | `npm rebuild` (runs install scripts offline), `npm test [-- targets]` |
| pip | `python -m venv .venv`; `pip install --require-hashes --no-deps --only-binary=:all: -r requirements.txt` | `.venv/bin/python -m pytest [targets]` |
| uv | `uv sync --frozen --no-build` | `uv run --frozen --offline --no-sync pytest [targets]` |

`--only-binary` and `--no-build` mean no sdist build (arbitrary code) runs during
provisioning. Packages that ship only sdists are therefore unavailable, which gives
`unsupported_environment` (§5.5: native dependencies need approved prebuilt inputs).
Verification commands also get offline environment settings (`npm_config_offline`,
`PIP_NO_INDEX`, `UV_OFFLINE`, empty proxy variables). These are belt and braces; the
real guarantee is the VM's network policy.

## Decision 6: result classification and the repair cap

- A command passes only when it exits 0 **and** the supervisor read a report with at
  least one suite. A timeout, a signal, a missing or unreadable report, or zero or
  unknown suites is `inconclusive`, never a pass. A non-zero exit with no report is
  also inconclusive, because a crashed runner is not a test failure.
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
own command plans against the public registries. That is the only host-side execution.
It proves the fixtures and the plans, not isolation.

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
4. **Report capture.** Classification needs a supervisor-parsed report (suite count).
   Choose the reporter per ecosystem (node `--test-reporter=junit`, pytest `--junitxml`)
   and make sure the report path is outside repository control.
5. **Hardened images.** Build the derived Node and Python profiles (uv installed, no
   sudo, dropped capabilities). Publish their digests as manifest `2026.10.1` or later.
6. **Cache audit.** Run `checkArtifact` over the Verdaccio and proxpi caches after
   provisioning and record the result in the receipt evidence.
7. **Escape attempts.** Exercise direct DNS, direct egress, IP literals, metadata
   addresses and redirect chains from inside the worker against the real proxy.
