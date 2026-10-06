# Issue #987: Adoption ledger: add website traffic (follow-up to #985)

Durable investigation copy under `docs/planning/` because this repository ignores
root `PLANNING-*.md` files. No ignored file is force-added.

## Problem
Include website traffic in the weekly adoption funnel ledger on #985. Issue #987
explicitly leaves the provider, aggregate metric, and unattended access contract
undecided. Investigation against base `f09cd1c` confirms those decisions remain
unresolved. No existing plan:v1 artifact was present.

The owner-approved slice on #985 deliberately deferred website metrics and said
not to guess the endpoint/credential path:
https://github.com/imboard-ai/ai-dossier/issues/985#issuecomment-5942259053

## Acceptance Criteria
- [ ] AC1 Weekly ledger comment on #985 includes the chosen website metric.

AC1 is not met: there is no chosen metric or approved source yet.

## Predicted Files
Conditional on the owner's source/metric/access decision, not an approved build plan:
- `scripts/adoption-funnel.mjs` — collect the chosen metric, label its period and
  unavailable status, and include it in the structured and human-readable ledger.
- `scripts/adoption-funnel.test.mjs` — exercise the chosen provider contract,
  baseline/delta behavior and missing access/data without fabricated values.
- `.github/workflows/adoption-funnel.yml` — bind approved unattended read access.

Client-side instrumentation, if chosen, would additionally affect website source
and its existing no-analytics statements; scope requires an explicit decision.
Only this investigation document was changed in this run.

## Approach
1. Preserve the investigation and hand off the unresolved product/access choices
   on the original issue, with `decision-pending` and a blocked plan milestone.
2. Owner selects either an already enabled server-side aggregate source, or a
   provider to enable/instrument; identify the website property/project and a
   supported aggregate read API/export. Hosting on Vercel does not establish that
   Vercel Web Analytics is enabled or queryable unattended.
3. Owner specifies the metric and its definition: unique visitors or pageviews,
   collection window/timezone, site coverage (production vs previews), and
   treatment of bots. Referrers are a breakdown rather than an interchangeable
   scalar count. No choice is silently made here.
4. Establish the actual machine-read credential and scheduled-job access route
   for that source, then implement and test the collector against that contract.

## Reachability Evidence
N/A — scheduled aggregate collection is infrastructure automation, not a new
production record state requiring a database occurrence count. No MongoDB
production tool is exposed in this harness and a registry database would not
prove website visitor counts. No website count was observed or invented.

Read-only live observation on 2026-10-06: Node `fetch` of
`https://ai-dossier.dev` with a 30-second timeout returned HTTP 200 at
`https://ai-dossier.dev/`; the HTML had no external script `src` attributes,
included `runs no analytics or trackers`, and had no matches for
`_vercel/insights`, `va.vercel-scripts`, `googletagmanager`, `google-analytics`,
`plausible`, `umami`, `posthog`, or `fathom`. This corroborates the source, but
does not rule out server-side traffic logs or dashboard-only configuration.

## Reusable Code
- `scripts/adoption-funnel.mjs:25,79-117,161-178,189-220` — existing collector,
  `adoption-funnel:v1` serialization, rendering and issue-comment destination.
  Current collector includes npm/GitHub only and explicitly defers #987.
- `.github/workflows/adoption-funnel.yml:3-24` — Monday 07:00 UTC schedule/manual
  dispatch; `contents: read`, `issues: write`, GitHub token, target issue #985.
- `.github/workflows/vercel-failure-logs.yml:17-45,47-89` — an existing documented
  Vercel credential route: SSM SecureString `/dossier/vercel_token` in `us-east-1`
  via `github-dossier-vercel-logs`. The documented trust is for the
  `deployment_status` empty-ref subject, not schedule/manual-dispatch. This is
  build-log access, not proof of analytics permission, export API or token scope.

## Investigation Evidence
- `website/README.md:36-48` — Vercel hosting settings and explicit
  "No analytics, cookies or third-party requests."
- `website/src/components/Footer.astro:21-25` — public no-analytics statement.
- `website/src/layouts/Base.astro:41-77` — common layout includes JSON-LD but no
  analytics collector; `website/package.json:19-23` has no analytics SDK.
- Repository searches across website source, docs and workflows found no
  analytics provider integration or chosen metric contract.
- Issue #49 originally mentioned "Basic analytics (Plausible or similar)" as an
  unchecked technical item. Its delivery comment documents hosting, not an
  analytics provider. Issue #26 concerns opt-in CLI/MCP execution telemetry, not
  website traffic; it is not a website analytics contract.
- GitHub read-only metadata: repository Actions secrets `total_count=0`, org
  Actions secrets `total_count=0`; `Production` and `Production – ai-dossier`
  environment secrets each `total_count=0`, variables each empty. Repository
  variables contain no analytics configuration. This does not imply SSM lacks
  a Vercel token: the separate build-log workflow documents one there. No secret
  value was retrieved, displayed or committed.
- The latest visible #985 weekly entry on 2026-10-05 explicitly excludes website
  traffic: https://github.com/imboard-ai/ai-dossier/issues/985#issuecomment-5990014205

## Risk Areas
- Analytics selection and instrumentation change the site's existing
  no-analytics product stance; this is a preference/scope decision, not a coding
  convention an unattended run can choose.
- A Vercel deployment token does not prove a supported analytics export/read
  endpoint, correct property, metric definition or scheduled OIDC trust.
- Repository/environment secret lists are metadata only; their absence cannot
  disprove credentials in an external store or server-side analytics.
- Preserve the `adoption-funnel:v1` established types and distinguish missing
  data from zero (trap index row at `docs/agent-traps.md:112`).
- This issue runs independently of #986; no dependency on its implementation
  or unresolved registry-account/pull choices is asserted.

## Test Scope
For this plan-only handoff: inspect the documentary and live HTML evidence,
check the diff for accidental code/credential changes, and verify pushed branch
and terminal issue state. No implementation or tests were added, and no build
or test suite was run for this investigation document.

After the decision: meaningful provider-fixture tests for successful reads,
authentication/endpoint failure, missing metric vs zero, window labeling and
baseline/deltas; verify the scheduled access route and the actual comment on
#985. Preserve the existing npm/GitHub ledger behavior.

## Open Questions
1. Which source/provider should measure `ai-dossier.dev`, with which exact
   property/project and supported API/export? Should existing server-side logs
   be used, or new analytics instrumentation enabled?
2. Which aggregate metric and exact reporting window/timezone/site/bot scope
   should the weekly ledger contain?
3. What approved unattended credential/access route grants the Monday job that
   read? If reusing SSM/Vercel access, confirm analytics scope and a schedule/
   manual-dispatch-compatible IAM trust path; build-log trust is not sufficient.

Classification: provider/metric/instrumentation are product preferences, so the
full-cycle preference handoff applies directly. The observable question of
whether source/live HTML already embeds analytics was answered read-only above;
no throwaway implementation sketch can decide the owner's metric or create an
approved access contract.

## Visual Review
- [x] Not required for this investigation-only handoff. Re-evaluate after scope
  is chosen if website instrumentation/copy changes are required.

## Base Branch
`main` — PRs for this issue target this branch after the decision is resolved.

## Run Provenance
Run `r-987-f412`, actual model `openai/gpt-6.1-sol`. Mid tier was requested but
this harness exposes no Task/model selector. Existing warm pool entry claimed,
with no unrelated maintenance or replenishment. Requested `ship_mode=detached`
is not reached: plan hands off before implementation/review/ship. No PR or
auto-merge request is created for an unresolved provider/metric decision.
