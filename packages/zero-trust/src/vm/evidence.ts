/** Host-side evaluation of hostile-fixture evidence (scenario 4, canary design).
 * Fixture reports are untrusted guest output: they can only make the verdict
 * worse. Canary leaks and listener connections are measured on the host. */

export const ATTACK_CATEGORIES = Object.freeze([
  'host-env',
  'host-file',
  'host-loopback',
  'lan',
  'metadata',
  'direct-egress',
  'dns',
  'privilege-escalation',
  'container-escape',
  'broker-abuse',
] as const);
export type AttackCategory = (typeof ATTACK_CATEGORIES)[number];

export interface ProbeRecord {
  readonly category: string;
  readonly attempt: string;
  readonly outcome: string;
  readonly detail?: string;
}

export interface ProbeReport {
  readonly probe: string;
  readonly phase: string;
  readonly records: readonly ProbeRecord[];
}

export interface BoundaryInput {
  readonly reports: readonly ProbeReport[];
  /** Every byte the guest returned: exec output and broker file transfers. */
  readonly guestOutputs: readonly string[];
  /** Freshly planted canary values. */
  readonly canaries: readonly string[];
  /** Connections accepted by the planted host listeners. */
  readonly listenerConnections: number;
  /** Host-side broker-abuse checks (request rejected before reaching the guest). */
  readonly brokerChecks: readonly { readonly attempt: string; readonly rejected: boolean }[];
  readonly requiredCategories?: readonly string[];
}

export interface BoundaryEvidence {
  readonly held: boolean;
  readonly violations: readonly string[];
  readonly coverage: Readonly<Record<string, number>>;
  readonly attempts: number;
}

export const REPORT_MARKER = 'ZT-PROBE-REPORT ';

/** Extracts marker lines from untrusted output; malformed lines are violations. */
export function parseReports(output: string): { reports: ProbeReport[]; malformed: number } {
  const reports: ProbeReport[] = [];
  let malformed = 0;
  for (const line of output.split('\n')) {
    const at = line.indexOf(REPORT_MARKER);
    if (at < 0) continue;
    try {
      reports.push(parseReport(JSON.parse(line.slice(at + REPORT_MARKER.length))));
    } catch {
      malformed++;
    }
  }
  return { reports, malformed };
}

export function parseReport(value: unknown): ProbeReport {
  const v = value as ProbeReport;
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof v.probe !== 'string' ||
    typeof v.phase !== 'string' ||
    !Array.isArray(v.records) ||
    v.records.some(
      (r) =>
        typeof r !== 'object' ||
        r === null ||
        typeof r.category !== 'string' ||
        typeof r.attempt !== 'string' ||
        typeof r.outcome !== 'string'
    )
  )
    throw new Error('Malformed probe report');
  return v;
}

export function evaluateBoundary(input: BoundaryInput): BoundaryEvidence {
  const violations: string[] = [];
  const coverage: Record<string, number> = {};
  let attempts = 0;
  for (const report of input.reports) {
    for (const record of report.records) {
      attempts++;
      coverage[record.category] = (coverage[record.category] ?? 0) + 1;
      // Only an explicit denial (or a witness observation) counts; anything else fails closed.
      const ok =
        record.outcome === 'denied' ||
        (record.category === 'witness' && record.outcome === 'observed');
      if (!ok)
        violations.push(
          `${report.probe}/${report.phase}: ${record.category} ${record.attempt} -> ${record.outcome}`
        );
    }
  }
  for (const check of input.brokerChecks) {
    attempts++;
    coverage['broker-abuse'] = (coverage['broker-abuse'] ?? 0) + 1;
    if (!check.rejected) violations.push(`host: broker-abuse ${check.attempt} -> accepted`);
  }
  for (const category of input.requiredCategories ?? ATTACK_CATEGORIES)
    if (!coverage[category]) violations.push(`missing coverage: ${category}`);
  if (input.canaries.some((c) => c.length < 16))
    violations.push('canary too short to be meaningful');
  for (const canary of input.canaries)
    if (input.guestOutputs.some((out) => out.includes(canary)))
      violations.push('canary value leaked into guest output');
  if (input.listenerConnections !== 0)
    violations.push(`host listeners accepted ${input.listenerConnections} connection(s)`);
  return { held: violations.length === 0, violations, coverage, attempts };
}

export class BoundaryBreachError extends Error {
  constructor(readonly violations: readonly string[]) {
    super('Isolation boundary failed; no shipping authorization may be issued');
    this.name = 'BoundaryBreachError';
  }
}

/** A boundary failure blocks shipping authorization for the run (scenario 4). */
export function assertBoundaryHeld(evidence: BoundaryEvidence): void {
  if (!evidence.held) throw new BoundaryBreachError(evidence.violations);
}
