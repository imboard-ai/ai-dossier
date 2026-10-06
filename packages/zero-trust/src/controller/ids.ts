/** This foundation creates one run per contribution; revisions are budget sessions. */
export function contributionIdOf(runId: string): string | undefined {
  return /^(ztc-[a-f0-9]{16})-run-1$/u.exec(runId)?.[1];
}
