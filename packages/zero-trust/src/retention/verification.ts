import { type CommandOutcome, classifyCommand } from '../ecosystem/classify';
import { evidenceVerified, parseCommandEvidence } from '../receipt/schema';
import { isRecord } from '../state';
import { refuse } from './files';

/** Reclassify actual producer facts; a claimed passed status is never sufficient. */
export function parseVerification(raw: unknown, runId: string) {
  if (
    !isRecord(raw) ||
    raw.runId !== runId ||
    typeof raw.candidateSha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(raw.candidateSha) ||
    !Array.isArray(raw.records) ||
    raw.records.length > 128
  )
    refuse();
  const records = raw.records;
  const commands = records.map((record) => {
    if (
      !isRecord(record) ||
      !isRecord(record.log) ||
      !isRecord(record.evidence) ||
      record.phase !== 'verification' ||
      record.network !== 'none' ||
      typeof record.timedOut !== 'boolean' ||
      typeof record.captureReport !== 'boolean' ||
      !Number.isSafeInteger(record.durationMs) ||
      Number(record.durationMs) < 0 ||
      !Number.isSafeInteger(record.log.bytes) ||
      Number(record.log.bytes) < 0 ||
      typeof record.log.excerpt !== 'string' ||
      typeof record.log.excerptTruncated !== 'boolean' ||
      typeof record.log.redacted !== 'boolean' ||
      typeof record.log.outputTruncated !== 'boolean' ||
      record.log.digest !== record.evidence.sanitizedLogDigest ||
      record.status !== record.evidence.status ||
      record.id !== record.evidence.id ||
      record.argv !== record.evidence.command ||
      (record.timedOut || record.exitCode === null ? 'unknown' : record.exitCode) !==
        record.evidence.exitStatus ||
      (!record.timedOut && record.exitCode !== null ? (record.suites ?? 'unknown') : 'unknown') !==
        record.evidence.suites ||
      (record.exitCode !== null &&
        (!Number.isInteger(record.exitCode) ||
          Number(record.exitCode) < 0 ||
          Number(record.exitCode) > 255))
    )
      refuse();
    const counts = [record.suites, record.tests, record.failures, record.skipped];
    if (
      counts.some((value) => value !== null) &&
      (counts.some((value) => !Number.isSafeInteger(value) || Number(value) < 0) ||
        Number(record.failures) + Number(record.skipped) > Number(record.tests))
    )
      refuse();
    if (!record.captureReport && counts.some((value) => value !== null)) refuse();
    const observed: CommandOutcome = record.timedOut
      ? { kind: 'timeout' }
      : record.exitCode === null
        ? { kind: 'signal', signal: 'unknown' }
        : {
            kind: 'exited',
            exitCode: Number(record.exitCode),
            report:
              record.suites === null
                ? null
                : {
                    suites: Number(record.suites),
                    tests: Number(record.tests),
                    failures: Number(record.failures),
                    skipped: Number(record.skipped),
                  },
          };
    if (
      record.status !== classifyCommand({ captureReport: record.captureReport }, observed) ||
      (record.status === 'passed' && record.log.outputTruncated)
    )
      refuse();
    return record.evidence;
  });
  // Validate every supervised record, even setup commands that cannot establish
  // test success. Successful non-report setup does not count as a test; failed,
  // uncertain or truncated setup must remain visible and prevent attribution.
  parseCommandEvidence(commands);
  const projected = commands.filter((_, index) => {
    const record = records[index];
    return (
      record.captureReport || record.exitCode !== 0 || record.timedOut || record.log.outputTruncated
    );
  });
  // A setup-only source remains inconclusive, never an empty successful test set.
  const validated = parseCommandEvidence(projected.length ? projected : commands);
  return {
    receiptDigest: null,
    candidateSha: raw.candidateSha,
    verified: evidenceVerified(validated),
    commands: validated,
  };
}
