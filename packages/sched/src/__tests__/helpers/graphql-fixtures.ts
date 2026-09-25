/**
 * Builds the `gh api graphql` stdout envelope that
 * `parseIssueCloseTruthJson` (`../../groundtruth`) parses — the exact shape
 * `issueCloseTruth`'s `ISSUE_CLOSE_QUERY` response takes on the wire.
 *
 * Extracted (#829 DRY review) out of this package's own
 * `anchor-close.test.ts`, where it started life as a local `graphqlIssue()`,
 * once `cli/src/__tests__/commands/sched.test.ts` needed the identical shape
 * to stub the same `gh api graphql` call from the CLI side (reachable there
 * only once `cli/vitest.config.ts` started resolving `@ai-dossier/sched` to
 * this package's TS source — see `docs/agent-traps.md`'s #829 row). Lives
 * under `__tests__/` on purpose: `packages/sched/tsconfig.json` excludes
 * `src/**\/__tests__` wholesale, so this never reaches `dist/` or the
 * published npm package, same as every other file in this directory.
 */
export function graphqlIssueResponse(opts: {
  state: 'OPEN' | 'CLOSED';
  stateReason?: string;
  closer?: unknown;
}): unknown {
  return {
    data: {
      repository: {
        issue: {
          state: opts.state,
          stateReason: opts.stateReason ?? null,
          labels: { nodes: [], pageInfo: { hasNextPage: false } },
          timelineItems: { nodes: opts.closer !== undefined ? [{ closer: opts.closer }] : [] },
          reopens: { nodes: [] },
          closedByPullRequestsReferences: { nodes: [] },
        },
      },
    },
  };
}
