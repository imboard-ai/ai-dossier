/** Strict reader for fully pinned, hash-locked pip requirements (`--require-hashes`).
 * Lines are split and joined exactly as pip does, so the file detection approves is the
 * file pip applies; any include, index, URL or unpinned line is rejected. */
import { PIP_HASH_PREFIX } from './registries';

/** PEP 503 normalization. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export interface PinnedRequirement {
  readonly name: string;
  readonly version: string;
  readonly hashes: readonly string[];
}
export interface RequirementsRejection {
  readonly reason:
    | 'lockfile_invalid'
    | 'unsupported_requirement_option'
    | 'non_registry_dependency'
    | 'unpinned_requirement'
    | 'missing_hashes';
  readonly detail?: string;
}

const SHA256_HASH = new RegExp(`^${PIP_HASH_PREFIX}[a-f0-9]{64}$`);
const PEP503_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const OPTION_NAME = /^-{1,2}[A-Za-z][A-Za-z-]*/;
const REQUIREMENT =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9._,\s-]*\])?\s*==\s*([A-Za-z0-9.+!-]+)$/;
/** Python's `str.splitlines()` boundaries, which pip uses to read the file. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are pip's own line boundaries.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
/** pip's COMMENT_RE: `#` at the start of a line or after whitespace. */
const COMMENT = /(^|\s+)#.*$/;

/** pip's `join_lines`: a trailing backslash joins the next line with no separator,
 * except that a comment line never continues and ends any pending join. */
function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let pending: string[] = [];
  for (const line of text.split(LINE_BREAK)) {
    const comment = /^\s*#/.test(line);
    if (!line.endsWith('\\') || comment) {
      const complete = comment ? ` ${line}` : line;
      lines.push(pending.length ? [...pending, complete].join('') : complete);
      pending = [];
    } else {
      pending.push(line.slice(0, -1));
    }
  }
  if (pending.length) lines.push(pending.join(''));
  return lines;
}

function optionName(token: string): string {
  return OPTION_NAME.exec(token)?.[0] ?? 'option';
}

export function parseHashedRequirements(text: string): PinnedRequirement[] | RequirementsRejection {
  // pip expands ${VAR} from the environment; a locked file has nothing to expand.
  if (text.includes('${')) return { reason: 'lockfile_invalid', detail: 'requirements.txt' };
  const requirements: PinnedRequirement[] = [];
  for (const raw of logicalLines(text)) {
    const line = raw.replace(COMMENT, '').trim();
    if (line === '') continue;
    if (line.startsWith('-')) {
      if (line === '--require-hashes') continue;
      return { reason: 'unsupported_requirement_option', detail: optionName(line) };
    }
    const tokens = line.split(/\s+/);
    const optionsAt = tokens.findIndex((t) => t.startsWith('-'));
    const spec = (optionsAt === -1 ? tokens : tokens.slice(0, optionsAt)).join(' ');
    const options = optionsAt === -1 ? [] : tokens.slice(optionsAt);
    const requirement = spec.split(';')[0].trim();
    const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(requirement)?.[0];
    if (requirement.includes('@') || requirement.includes('://'))
      return { reason: 'non_registry_dependency', ...(name ? { detail: name } : {}) };
    const match = REQUIREMENT.exec(requirement);
    if (!match || !PEP503_NAME.test(match[1]))
      return { reason: 'unpinned_requirement', ...(name ? { detail: name } : {}) };
    const bad = options.find((o) => !SHA256_HASH.test(o));
    if (bad !== undefined)
      return { reason: 'unsupported_requirement_option', detail: optionName(bad) };
    if (options.length === 0) return { reason: 'missing_hashes', detail: match[1] };
    requirements.push(
      Object.freeze({
        name: normalizeName(match[1]),
        version: match[2],
        hashes: Object.freeze(options.map((o) => o.slice(PIP_HASH_PREFIX.length))),
      })
    );
  }
  return requirements;
}
