# Gate 2 ecosystem fixtures

Three small projects, one per supported package manager, each with one known bug.
They are the inputs for feasibility gate 2 ([PRD](../../../../docs/features/zero-trust-full-cycle/prd.md)
§5.5, §5.6, scenarios 6 and 7): provision through the package proxy, reproduce the bug,
and verify offline against an exact commit.

Each fixture has the same layout:

| Path | Meaning |
|---|---|
| `base/` | The upstream baseline: buggy code plus an existing suite that passes |
| `regression.patch` | Adds the regression test only. It fails on `base` |
| `fix.patch` | The smallest source fix. Suite and regression test pass |

| Fixture | Manager and lockfile | Profile selected | Known bug | Regression test |
|---|---|---|---|---|
| `npm/` | npm, `package-lock.json` v3, dependency `ms` | `node-22` (`engines.node >=20`) | `toSeconds()` divides milliseconds by 100, so `"90s"` gives 900 | `test/regression.test.js` |
| `pip/` | pip, `requirements.txt` fully pinned with `--hash` (pytest and its dependencies) | `python-3.13` (`requires-python >=3.11`) | `slugify()` turns each separator into its own hyphen, so `"Hello,  World!"` gives `hello---world` | `tests/test_regression.py` |
| `uv/` | uv, `uv.lock` (virtual project, pytest in the `dev` group) | `python-3.13` (`requires-python >=3.11`) | `chunk()` drops a trailing partial chunk | `tests/test_regression.py` |

## Self-check (CI only)

`scripts/zero-trust-fixtures-selfcheck.mjs` builds each fixture into a throwaway Git
repository with three commits (base, regression, fix). It runs the package's own
`buildCommandPlan` argv and records each command, its network tag and exit code:

1. provisioning, then the baseline suite on `base`: pass
2. the regression test on the regression commit: **fail**
3. the regression test and the suite on the fix commit: pass

The `Zero-trust fixtures` workflow runs it on pull requests that touch the package.
Public registries stand in for the proxy there. This is the only place fixture installs
or tests run on a host. The product code builds plans as data and executes nothing.
The isolated run behind the proxy belongs to #1010.

## Regenerating lockfiles

Lockfiles were generated with `npm install --package-lock-only --ignore-scripts`,
`uv pip compile --universal --generate-hashes --python-version 3.11` and `uv lock`.
After a regeneration, re-run the self-check and update the patches if context lines moved.
