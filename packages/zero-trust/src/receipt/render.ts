import { receiptDigest } from './issue';
import { parseReceipt } from './schema';

function escapeHtml(text: string): string {
  // Repository-controlled command/profile text is evidence, never a success
  // claim. Neutralize the forbidden blanket claim even when quoted by a command.
  text = text.replace(/all tests passed/gi, '[untrusted success claim]');
  return text.replace(
    /[&<>"'`\r\n]/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '`': '&#96;',
        '\r': '&#13;',
        '\n': '&#10;',
      })[c] as string
  );
}
/** Optional block: caller decides whether upstream policy/template allows it.
 * Validates/redacts before rendering; never outputs raw logs or credentials.
 * This displays evidence, not a claim that the signature was authenticated. */
export function renderReceipt(input: unknown): string {
  const r = parseReceipt(input);
  const lines = [
    '<details><summary>Verification receipt</summary>',
    `<p>Profile: ${escapeHtml(r.profile.name)}; runtime: ${escapeHtml(r.profile.runtime)}; image: ${escapeHtml(r.profile.imageDigest)}</p>`,
    `<p>Candidate: ${r.candidateSha}; base/parent: ${r.baseSha}</p>`,
    `<p>Profile digest: ${r.profileDigest}; policy digest: ${r.policyDigest}</p>`,
    '<ul>',
    ...r.commands.map(
      (c) =>
        `<li><code>${escapeHtml(c.command)}</code>: ${c.status}; exit=${c.exitStatus}; suites=${c.suites}; sanitized log SHA-256=${c.sanitizedLogDigest}</li>`
    ),
    '</ul>',
    `<p>Network: ${Object.entries(r.networkPolicy)
      .map(([phase, policy]) => `${phase}=${escapeHtml(policy)}`)
      .join('; ')}</p>`,
    `<p>Receipt SHA-256: ${receiptDigest(r)}; required evidence: ${r.verified ? 'verified' : 'not verified'}</p>`,
    '<p>Evidence applies only to this candidate; it does not certify patch correctness or absence of exploits.</p>',
    '</details>',
  ];
  return lines.join('\n');
}
