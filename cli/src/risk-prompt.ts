import readline from 'node:readline';
import { needsRiskConfirmation, riskSummaryLines } from './verify-guidance';

export interface RiskPromptOptions {
  force?: boolean;
  /** Commander's `--no-prompt` sets `prompt: false`. */
  prompt?: boolean;
  headless?: boolean;
  dryRun?: boolean;
}

export type RiskDecision =
  | { action: 'none' }
  | { action: 'proceed'; lines: string[]; reason: string }
  | { action: 'confirm'; lines: string[] };

/**
 * Decide whether `run` must ask before executing. Pure: never touches the TTY,
 * so callers (and tests) pass `interactive` in. Anything non-interactive, or
 * explicitly opted out (--force, --no-prompt, --headless), proceeds so CI never
 * hangs; the risk is still shown.
 */
export function decideRiskConfirmation(
  fm: { risk_level?: string; risk_factors?: unknown },
  options: RiskPromptOptions,
  interactive: boolean
): RiskDecision {
  if (!needsRiskConfirmation(fm)) return { action: 'none' };
  const lines = riskSummaryLines(fm);
  if (options.force) return { action: 'proceed', lines, reason: '--force' };
  if (options.prompt === false) return { action: 'proceed', lines, reason: '--no-prompt' };
  if (options.headless) return { action: 'proceed', lines, reason: '--headless' };
  if (options.dryRun) return { action: 'proceed', lines, reason: '--dry-run' };
  if (!interactive) return { action: 'proceed', lines, reason: 'non-interactive session' };
  return { action: 'confirm', lines };
}

/** Ask `Continue? [y/N]` on the terminal; anything but y/yes declines. */
export function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
    rl.on('close', () => resolve(false));
  });
}
