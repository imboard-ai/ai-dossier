/**
 * Capability manifest engine (RFC-0001 capabilities, issue #463).
 *
 * A repo declares its deterministic, recurring operations (test, lint, build,
 * dependency install, worktree prep, …) in `.dossier/automation/manifest.yaml`.
 * `ai-dossier cap list` inspects the manifest; `ai-dossier cap run <id>` executes
 * one capability and reports one of exactly four outcomes, distinguishable by
 * exit code and by a JSON envelope printed as the final stdout line:
 *
 *   ok                     exit 0  — command ran, exit 0
 *   task-failed            exit 1  — command ran, nonzero exit (e.g. red tests)
 *   automation-broken      exit 2  — assumption probe failed, command missing,
 *                                    or abnormal termination
 *   capability-unavailable exit 3  — id not in the manifest (or lifecycle=shadow)
 *
 * The engine is pure logic (no CLI dependencies) so the scheduler's slot-cycle
 * fast path (#464) can consume it directly later.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Directory (repo-relative) that holds the automation manifest. */
export const AUTOMATION_DIR = '.dossier/automation';
/** File name of the manifest inside {@link AUTOMATION_DIR}. */
export const MANIFEST_FILE = 'manifest.yaml';

export type CapabilityOutcome =
  | 'ok'
  | 'task-failed'
  | 'automation-broken'
  | 'capability-unavailable';

export type CapabilityLifecycle = 'active' | 'shadow';

/** The four-way outcome contract, as process exit codes. */
export const CAPABILITY_EXIT_CODES: Record<CapabilityOutcome, number> = {
  ok: 0,
  'task-failed': 1,
  'automation-broken': 2,
  'capability-unavailable': 3,
};

export interface FileExistsProbe {
  kind: 'file-exists';
  /** Path relative to the directory the command runs in. */
  target: string;
}

export interface ToolVersionProbe {
  kind: 'tool-version';
  tool: string;
  op: '>=' | '>' | '<=' | '<' | '=' | '==';
  version: string;
}

export type CapabilityAssumption = FileExistsProbe | ToolVersionProbe;

export interface CapabilityEntry {
  /** Command line to execute; extra `cap run` args are appended after it. */
  command: string;
  lifecycle: CapabilityLifecycle;
  assumptions?: CapabilityAssumption[];
  description?: string;
}

export interface CapabilityManifest {
  /** Absolute path of the manifest file, or null when no manifest exists. */
  path: string | null;
  capabilities: Record<string, CapabilityEntry>;
}

/** The manifest exists but does not conform to the schema. */
export class CapManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapManifestError';
  }
}

const CAPABILITY_ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
const TOOL_VERSION_OPS = ['>=', '>', '<=', '<', '=', '=='] as const;
type ToolVersionOp = (typeof TOOL_VERSION_OPS)[number];

// ============================================================================
// Manifest loading and validation
// ============================================================================

/**
 * Load the capability manifest for a directory. Absent `.dossier/automation/`
 * is the normal portable state: returns an empty manifest with `path: null`.
 * A present-but-invalid manifest throws {@link CapManifestError}.
 */
export function loadCapabilityManifest(cwd: string): CapabilityManifest {
  const manifestPath = path.resolve(cwd, AUTOMATION_DIR, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return { path: null, capabilities: {} };
  }
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    throw new CapManifestError(`cannot read ${manifestPath}: ${(err as Error).message}`);
  }
  const capabilities = parseCapabilityManifest(text);
  return { path: manifestPath, capabilities };
}

/** Parse and validate manifest YAML into the capability map. */
export function parseCapabilityManifest(text: string): Record<string, CapabilityEntry> {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new CapManifestError(`manifest is not valid YAML: ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) {
    return {};
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new CapManifestError('manifest root must be a mapping');
  }
  const root = doc as Record<string, unknown>;
  if (root.version !== undefined && root.version !== 1) {
    throw new CapManifestError(`unsupported manifest version ${String(root.version)} — expected 1`);
  }
  if (root.capabilities === undefined) {
    throw new CapManifestError("manifest must have a 'capabilities:' mapping of id → entry");
  }
  if (
    typeof root.capabilities !== 'object' ||
    root.capabilities === null ||
    Array.isArray(root.capabilities)
  ) {
    throw new CapManifestError("'capabilities:' must be a mapping of id → entry");
  }

  const capabilities: Record<string, CapabilityEntry> = {};
  for (const [id, raw] of Object.entries(root.capabilities)) {
    capabilities[id] = parseCapabilityEntry(id, raw);
  }
  return capabilities;
}

function parseCapabilityEntry(id: string, raw: unknown): CapabilityEntry {
  if (!CAPABILITY_ID_RE.test(id)) {
    throw new CapManifestError(
      `capability id '${id}' is invalid — use dotted lowercase words, e.g. 'test.focused'`
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CapManifestError(`capability '${id}' must be a mapping with a 'command'`);
  }
  const entry = raw as Record<string, unknown>;

  if (typeof entry.command !== 'string' || entry.command.trim() === '') {
    throw new CapManifestError(`capability '${id}' requires a non-empty 'command' string`);
  }

  let lifecycle: CapabilityLifecycle = 'active';
  if (entry.lifecycle !== undefined) {
    if (entry.lifecycle !== 'active' && entry.lifecycle !== 'shadow') {
      throw new CapManifestError(
        `capability '${id}': lifecycle must be 'active' or 'shadow', got '${String(entry.lifecycle)}'`
      );
    }
    lifecycle = entry.lifecycle;
  }

  let description: string | undefined;
  if (entry.description !== undefined) {
    if (typeof entry.description !== 'string') {
      throw new CapManifestError(`capability '${id}': description must be a string`);
    }
    description = entry.description;
  }

  let assumptions: CapabilityAssumption[] | undefined;
  if (entry.assumptions !== undefined) {
    if (!Array.isArray(entry.assumptions)) {
      throw new CapManifestError(`capability '${id}': assumptions must be a list of probes`);
    }
    assumptions = entry.assumptions.map((probe, i) => parseAssumption(id, i, probe));
  }

  return { command: entry.command, lifecycle, assumptions, description };
}

function parseAssumption(id: string, index: number, raw: unknown): CapabilityAssumption {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CapManifestError(
      `capability '${id}' assumption #${index + 1} must be a single-key probe, e.g. { file-exists: package.json }`
    );
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    throw new CapManifestError(
      `capability '${id}' assumption #${index + 1} must have exactly one key (file-exists or tool-version)`
    );
  }
  const kind = keys[0];
  const value = (raw as Record<string, unknown>)[kind];

  if (kind === 'file-exists') {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new CapManifestError(
        `capability '${id}' assumption #${index + 1}: file-exists requires a path string`
      );
    }
    return { kind: 'file-exists', target: value };
  }
  if (kind === 'tool-version') {
    if (typeof value !== 'string') {
      throw new CapManifestError(
        `capability '${id}' assumption #${index + 1}: tool-version requires '<tool><op><version>', e.g. node>=20`
      );
    }
    return parseToolVersionProbe(id, index, value);
  }
  throw new CapManifestError(
    `capability '${id}' assumption #${index + 1}: unknown probe kind '${kind}' (expected file-exists or tool-version)`
  );
}

function parseToolVersionProbe(id: string, index: number, value: string): ToolVersionProbe {
  const match = /^([A-Za-z0-9._/-]+)\s*(>=|>|<=|<|==|=)\s*(.+)$/.exec(value.trim());
  if (!match) {
    throw new CapManifestError(
      `capability '${id}' assumption #${index + 1}: tool-version requires '<tool><op><version>', e.g. node>=20 (ops: >= > <= < =)`
    );
  }
  return {
    kind: 'tool-version',
    tool: match[1],
    op: match[2] as ToolVersionOp,
    version: match[3].trim(),
  };
}

// ============================================================================
// Assumption probes
// ============================================================================

export interface ProbeResult {
  ok: boolean;
  reason: string;
}

/** Evaluate one assumption probe against the run directory. */
export function evaluateProbe(probe: CapabilityAssumption, cwd: string): ProbeResult {
  if (probe.kind === 'file-exists') {
    const target = path.resolve(cwd, probe.target);
    if (fs.existsSync(target)) {
      return { ok: true, reason: '' };
    }
    return { ok: false, reason: `file-exists: '${probe.target}' not found` };
  }

  // tool-version: run `<tool> --version` and compare the first version-like token
  const res = spawnSync(`${probe.tool} --version`, {
    shell: true,
    encoding: 'utf-8',
    windowsHide: true,
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.error || res.status !== 0) {
    return {
      ok: false,
      reason: `tool-version: '${probe.tool}' is not runnable (${res.error?.message ?? `exit ${res.status}`})`,
    };
  }
  const versionMatch = /\d+(\.\d+){0,3}/.exec(output);
  if (!versionMatch) {
    return {
      ok: false,
      reason: `tool-version: no version found in '${probe.tool} --version' output`,
    };
  }
  const actual = versionMatch[0];
  const cmp = compareVersions(actual, probe.version);
  const satisfied =
    probe.op === '>='
      ? cmp >= 0
      : probe.op === '>'
        ? cmp > 0
        : probe.op === '<='
          ? cmp <= 0
          : probe.op === '<'
            ? cmp < 0
            : cmp === 0;
  if (!satisfied) {
    return {
      ok: false,
      reason: `tool-version: ${probe.tool} ${actual} does not satisfy ${probe.tool}${probe.op}${probe.version}`,
    };
  }
  return { ok: true, reason: '' };
}

/** Compare two dotted-numeric versions: negative if a < b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ============================================================================
// Execution
// ============================================================================

export interface CapRunResult {
  outcome: CapabilityOutcome;
  capability: string;
  /** The command line that ran (or would have run), null when unknown. */
  command: string | null;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  /** Why a non-ok outcome happened (probe output, missing command, …). */
  reason: string | null;
}

/**
 * Resolve and execute one capability for a directory. Never throws for
 * manifest/permission/exec problems — they are reported as outcomes — but a
 * malformed manifest still surfaces as `automation-broken`, not a crash, so
 * callers (the scheduler) can fall back to reasoning.
 */
export function runCapabilityFromCwd(id: string, args: string[], cwd: string): CapRunResult {
  let manifest: CapabilityManifest;
  try {
    manifest = loadCapabilityManifest(cwd);
  } catch (err) {
    if (err instanceof CapManifestError) {
      return broken(id, null, `manifest invalid: ${err.message}`);
    }
    throw err;
  }
  return runCapability(manifest, id, args, cwd);
}

/** Execute a capability from an already-loaded manifest. */
export function runCapability(
  manifest: CapabilityManifest,
  id: string,
  args: string[],
  cwd: string
): CapRunResult {
  const start = Date.now();
  const entry = manifest.capabilities[id];

  if (!entry) {
    return {
      outcome: 'capability-unavailable',
      capability: id,
      command: null,
      exit_code: null,
      signal: null,
      duration_ms: Date.now() - start,
      reason: manifest.path
        ? `capability '${id}' is not in ${manifest.path}`
        : `no capability manifest at ${AUTOMATION_DIR}/${MANIFEST_FILE}`,
    };
  }

  if (entry.lifecycle !== 'active') {
    return {
      outcome: 'capability-unavailable',
      capability: id,
      command: entry.command,
      exit_code: null,
      signal: null,
      duration_ms: Date.now() - start,
      reason: `capability '${id}' has lifecycle=shadow — only active entries execute`,
    };
  }

  for (const probe of entry.assumptions ?? []) {
    const result = evaluateProbe(probe, cwd);
    if (!result.ok) {
      return broken(id, entry.command, `assumption failed — ${result.reason}; command not run`);
    }
  }

  const commandLine = [entry.command, ...args].join(' ');
  const res = spawnSync(commandLine, { shell: true, cwd, stdio: 'inherit' });
  const duration = Date.now() - start;

  if (res.error) {
    return broken(id, commandLine, `command failed to start: ${res.error.message}`);
  }
  // shell exit codes 126/127 mean the command itself could not run at all
  if (res.status === 127) {
    return broken(id, commandLine, 'command not found (exit 127)');
  }
  if (res.status === 126) {
    return broken(id, commandLine, 'command not executable (exit 126)');
  }
  if (res.signal !== null && res.signal !== undefined) {
    return {
      outcome: 'automation-broken',
      capability: id,
      command: commandLine,
      exit_code: null,
      signal: res.signal,
      duration_ms: duration,
      reason: `abnormal termination: killed by ${res.signal}`,
    };
  }
  // sh reports a child killed by signal N as exit 128+N
  if (res.status !== null && res.status > 128) {
    return {
      outcome: 'automation-broken',
      capability: id,
      command: commandLine,
      exit_code: res.status,
      signal: null,
      duration_ms: duration,
      reason: `abnormal termination: exit ${res.status} (killed by signal ${res.status - 128})`,
    };
  }

  if (res.status === 0) {
    return {
      outcome: 'ok',
      capability: id,
      command: commandLine,
      exit_code: 0,
      signal: null,
      duration_ms: duration,
      reason: null,
    };
  }
  return {
    outcome: 'task-failed',
    capability: id,
    command: commandLine,
    exit_code: res.status,
    signal: null,
    duration_ms: duration,
    reason: null,
  };
}

function broken(id: string, command: string | null, reason: string): CapRunResult {
  return {
    outcome: 'automation-broken',
    capability: id,
    command,
    exit_code: null,
    signal: null,
    duration_ms: 0,
    reason,
  };
}
