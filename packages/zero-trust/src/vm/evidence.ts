/** Host-side evaluation of hostile-fixture evidence (scenario 4, canary design).
 *
 * Trust model: everything a fixture reports about itself (records, outcomes,
 * coverage) is untrusted guest output. A compromised guest can lie, so reports
 * can only make the verdict worse — a malformed report, a non-denied outcome or
 * missing coverage fails the gate, but a clean report proves nothing alone.
 * The real gate is what the host measures itself: canary values (raw, base64,
 * hex) absent from every byte the guest returned, zero connections on the
 * planted host listeners, and host-side broker rejections. */

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
  readonly category: AttackCategory | 'witness';
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
  /** Marker lines that failed to parse (`parseReports().malformed`); any is a failure. */
  readonly malformedReports: number;
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

/** Guest strings end up in violations, the evidence file and the CI summary,
 * so only short, plain values are accepted; anything else counts as malformed. */
const REPORT_TEXT = /^[A-Za-z0-9 ._:/=-]{1,200}$/;
const OUTCOME = /^[a-z_-]{1,32}$/;
const REPORT_CATEGORIES: readonly string[] = [...ATTACK_CATEGORIES, 'witness'];

export function parseReport(value: unknown): ProbeReport {
  const v = value as ProbeReport;
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof v.probe !== 'string' ||
    !REPORT_TEXT.test(v.probe) ||
    typeof v.phase !== 'string' ||
    !REPORT_TEXT.test(v.phase) ||
    !Array.isArray(v.records) ||
    v.records.some(
      (r) =>
        typeof r !== 'object' ||
        r === null ||
        !REPORT_CATEGORIES.includes(r.category) ||
        typeof r.attempt !== 'string' ||
        !REPORT_TEXT.test(r.attempt) ||
        typeof r.outcome !== 'string' ||
        !OUTCOME.test(r.outcome)
    )
  )
    throw new Error('Malformed probe report');
  // A fresh object: nothing but the validated fields leaves the guest's report.
  return {
    probe: v.probe,
    phase: v.phase,
    records: v.records.map((r) => ({
      category: r.category,
      attempt: r.attempt,
      outcome: r.outcome,
      ...(typeof r.detail === 'string' ? { detail: r.detail.slice(0, 200) } : {}),
    })),
  };
}

/** Encodings of a canary to look for in guest output: raw, hex (both cases) and
 * the base64 text of the canary at each of the three byte alignments it can
 * take inside a longer encoded blob (only characters fully determined by the
 * canary bytes are kept, so the fragment matches wherever the canary sits).
 * Other transforms (URL-safe base64, compression, splitting, encryption) are
 * not detected; that limit is recorded in the decision record. */
export function canaryForms(canary: string): string[] {
  const bytes = Buffer.from(canary, 'utf8');
  const hex = bytes.toString('hex');
  const forms = new Set([canary, hex, hex.toUpperCase()]);
  for (let pad = 0; pad < 3; pad++) {
    const encoded = Buffer.concat([Buffer.alloc(pad), bytes]).toString('base64');
    const first = Math.ceil((8 * pad) / 6);
    const end = Math.floor((8 * (pad + bytes.length)) / 6);
    forms.add(encoded.slice(first, end));
  }
  return [...forms];
}

export function evaluateBoundary(input: BoundaryInput): BoundaryEvidence {
  const violations: string[] = [];
  const coverage: Record<string, number> = {};
  let attempts = 0;
  // A report the host cannot parse is treated as a hidden attempt, never skipped.
  if (!Number.isSafeInteger(input.malformedReports) || input.malformedReports !== 0)
    violations.push(`malformed probe reports: ${input.malformedReports}`);
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
    if (canaryForms(canary).some((form) => input.guestOutputs.some((out) => out.includes(form))))
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

/** Throws on any violation (scenario 4). Callers must treat a breach as blocking
 * shipping authorization for the run; today the gate suite is the caller. */
export function assertBoundaryHeld(evidence: BoundaryEvidence): void {
  if (!evidence.held) throw new BoundaryBreachError(evidence.violations);
}
