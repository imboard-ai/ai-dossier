import { assertNoSecrets } from '../redaction';

export const ENGAGEMENT_MAX_LENGTH = 1500;
export interface EngagementFacts {
  /** Controller-detected command, never model-authored text. */
  readonly testCommand?: string;
}

/** Fixed non-echoing diagnostics: facts must never become an error message. */
export class EngagementError extends Error {
  constructor() {
    super('Invalid engagement facts');
    this.name = 'EngagementError';
  }
}

export function engagementBody(facts: EngagementFacts): string {
  try {
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new Error();
    const command = facts.testCommand;
    if (
      command !== undefined &&
      (typeof command !== 'string' || !command.trim() || /[\p{Cc}\p{Cf}`<>]/u.test(command))
    )
      throw new Error();
    if (command !== undefined) assertNoSecrets(command);
    const verification = command === undefined ? '' : ` I intend to verify it with \`${command}\`.`;
    const body =
      'I would like to contribute a minimal fix with a focused regression test. ' +
      'I will use substantial LLM assistance through ai-dossier and review the resulting changes and test evidence.' +
      verification +
      ' Is this contribution welcome, and would you like to assign me to the issue?';
    if (body.length > ENGAGEMENT_MAX_LENGTH) throw new Error();
    assertNoSecrets(body);
    return body;
  } catch {
    throw new EngagementError();
  }
}
