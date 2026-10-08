import { isRunContinuation, ReasonCode, type RunRecord } from '../state';

/** Only these externally recorded steps may legitimately lag in tracker evidence. */
const EXTERNAL_REASONS: readonly ReasonCode[] = Object.freeze([
  ReasonCode.CandidateReady,
  ReasonCode.VerificationPassed,
  ReasonCode.RepairRequired,
  ReasonCode.UserPaused,
  ReasonCode.ResumeImplementing,
  ReasonCode.ResumeRevising,
  ReasonCode.ResumeVerifying,
  ReasonCode.ResumeShipping,
  ReasonCode.PolicyBlocked,
  ReasonCode.UnsupportedEnvironment,
  ReasonCode.ExecutionFailed,
  ReasonCode.UserCancelled,
  ReasonCode.CleanupFailed,
  ReasonCode.CleanupCompleted,
]);

export function isTrackerContinuation(previous: RunRecord, run: RunRecord): boolean {
  return (
    isRunContinuation(previous, run) &&
    run.history
      .slice(previous.history.length)
      .every((entry) => EXTERNAL_REASONS.includes(entry.reasonCode))
  );
}
