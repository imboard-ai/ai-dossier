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
 *                                    abnormal termination, timeout, or an
 *                                    invalid manifest
 *   capability-unavailable exit 3  — id not in the manifest (or lifecycle=shadow)
 *
 * The engine is pure logic (no CLI dependencies) so the scheduler's slot-cycle
 * fast path (#464) can consume it directly later.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { compareVersions } from './version';

/** Directory (relative to the run directory) that holds the automation manifest. */
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

// Shell exit-code semantics: 126 = found but not executable, 127 = not found,
// 128+N = the command was killed by signal N (as reported by sh).
const SHELL_EXIT_NOT_EXECUTABLE = 126;
const SHELL_EXIT_COMMAND_NOT_FOUND = 127;
const SHELL_SIGNAL_EXIT_BASE = 128;

/** Fixed cap on any single `<tool> --version` probe so a hung tool cannot hang `cap run`. */
const PROBE_TIMEOUT_MS = 10_000;

/** Default per-entry command timeout when the manifest does not set `timeout_ms`. */
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;

/**
 * Default byte length of `output_tail` (issue #583 AC1) — the last N bytes of
 * a non-`ok` run's combined stdout+stderr, captured for attribution. Override
 * per invocation with `cap run --tail-bytes <n>`.
 */
export const DEFAULT_OUTPUT_TAIL_BYTES = 8192;

/** `spawnSync`'s own default `maxBuffer` (1 MiB) is too small for a real test/build command's combined stdout+stderr — raised so output volume alone never causes a false `automation-broken` (#583 review). */
const MAX_CAPABILITY_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Supported tool-version comparison operators (single source of truth). */
const TOOL_VERSION_OPS = ['>=', '>', '<=', '<', '==', '='] as const;
type ToolVersionOp = (typeof TOOL_VERSION_OPS)[number];

const TOOL_VERSION_OPS_DISPLAY = [...TOOL_VERSION_OPS].sort().join(' ');
const TOOL_VERSION_RE = new RegExp(
  `^([A-Za-z0-9._/-]+)\\s*(${[...TOOL_VERSION_OPS].sort((a, b) => b.length - a.length).join('|')})\\s*(.+)$`
);

const OP_SATISFIED: Record<ToolVersionOp, (cmp: number) => boolean> = {
  '>=': (c) => c >= 0,
  '>': (c) => c > 0,
  '<=': (c) => c <= 0,
  '<': (c) => c < 0,
  '=': (c) => c === 0,
  '==': (c) => c === 0,
};

export interface FileExistsProbe {
  kind: 'file-exists';
  /** Path relative to the directory the command runs in. */
  target: string;
}

export interface ToolVersionProbe {
  kind: 'tool-version';
  tool: string;
  op: ToolVersionOp;
  version: string;
}

export type CapabilityAssumption = FileExistsProbe | ToolVersionProbe;

export interface CapabilityEntry {
  /** Command line to execute; extra `cap run` args are shell-quoted and appended after it. */
  command: string;
  lifecycle: CapabilityLifecycle;
  assumptions?: CapabilityAssumption[];
  description?: string;
  /** Per-entry command timeout in ms (default 5 min; timeout → automation-broken). */
  timeoutMs?: number;
  /**
   * Sanity floor (issue #583 AC2): a non-zero exit that finished faster than
   * this many ms is reclassified `automation-broken` instead of `task-failed`
   * — a fast non-zero exit is more likely "the automation didn't really run"
   * (e.g. a filter matched zero projects) than a genuine test failure.
   * Default 0 (no floor) — opt in per capability.
   */
  minDurationMs?: number;
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

// ============================================================================
// Manifest loading and validation
// ============================================================================

/**
 * Load the capability manifest for a directory. Absent `.dossier/automation/`
 * is the normal portable state: returns an empty manifest with `path: null`.
 * A present-but-invalid manifest throws {@link CapManifestError} whose message
 * names the file.
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
    throw new CapManifestError(`${manifestPath}: cannot read: ${(err as Error).message}`);
  }
  try {
    const capabilities = parseCapabilityManifest(text);
    return { path: manifestPath, capabilities };
  } catch (err) {
    if (err instanceof CapManifestError) {
      throw new CapManifestError(`${manifestPath}: ${err.message}`);
    }
    throw err;
  }
}

/** Parse and validate manifest YAML into the capability map. */
export function parseCapabilityManifest(text: string): Record<string, CapabilityEntry> {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new CapManifestError(`not valid YAML: ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) {
    return {};
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new CapManifestError('root must be a mapping');
  }
  const root = doc as Record<string, unknown>;
  if (root.version !== undefined && root.version !== 1) {
    throw new CapManifestError(
      `unsupported manifest version ${JSON.stringify(root.version)} — expected 1`
    );
  }
  if (root.capabilities === undefined) {
    throw new CapManifestError("must have a 'capabilities:' mapping of id → entry");
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

  let timeoutMs: number | undefined;
  if (entry.timeout_ms !== undefined) {
    if (
      typeof entry.timeout_ms !== 'number' ||
      !Number.isFinite(entry.timeout_ms) ||
      entry.timeout_ms <= 0
    ) {
      throw new CapManifestError(
        `capability '${id}': timeout_ms must be a positive number of milliseconds`
      );
    }
    timeoutMs = entry.timeout_ms;
  }

  let minDurationMs: number | undefined;
  if (entry.min_duration_ms !== undefined) {
    if (
      typeof entry.min_duration_ms !== 'number' ||
      !Number.isFinite(entry.min_duration_ms) ||
      entry.min_duration_ms < 0
    ) {
      throw new CapManifestError(
        `capability '${id}': min_duration_ms must be a non-negative number of milliseconds`
      );
    }
    minDurationMs = entry.min_duration_ms;
  }

  let assumptions: CapabilityAssumption[] | undefined;
  if (entry.assumptions !== undefined) {
    if (!Array.isArray(entry.assumptions)) {
      throw new CapManifestError(`capability '${id}': assumptions must be a list of probes`);
    }
    assumptions = entry.assumptions.map((probe, i) => parseAssumption(id, i, probe));
  }

  return { command: entry.command, lifecycle, assumptions, description, timeoutMs, minDurationMs };
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
  const match = TOOL_VERSION_RE.exec(value.trim());
  if (!match) {
    throw new CapManifestError(
      `capability '${id}' assumption #${index + 1}: tool-version requires '<tool><op><version>', e.g. node>=20 (ops: ${TOOL_VERSION_OPS_DISPLAY})`
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

  // tool-version: run `<tool> --version` in the capability's cwd and compare
  // the first version-like token
  const res = spawnSync(`${probe.tool} --version`, {
    shell: true,
    cwd,
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
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
  if (!OP_SATISFIED[probe.op](cmp)) {
    return {
      ok: false,
      reason: `tool-version: ${probe.tool} ${actual} does not satisfy ${probe.tool}${probe.op}${probe.version}`,
    };
  }
  return { ok: true, reason: '' };
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
  /**
   * Wall-clock duration of the run in milliseconds. Zero only when nothing was
   * timed (unknown id, shadow refusal, invalid manifest); probe failures and
   * spawn problems report real elapsed time.
   */
  duration_ms: number;
  /** Why a non-ok outcome happened (probe output, missing command, …). */
  reason: string | null;
  /**
   * Last `tailBytes` of the combined stdout+stderr (issue #583 AC1/AC3),
   * present only for non-`ok` outcomes that actually spawned a process.
   * `undefined` for `ok` (keeps the success envelope small) and for outcomes
   * classified before any subprocess ran (unknown id, shadow lifecycle,
   * failed assumption probe).
   */
  output_tail?: string;
}

/**
 * Quote one argv element so the shell receives it verbatim as a single word.
 * POSIX single-quote scheme (the only fully safe one); args are data, not
 * shell syntax — put syntax in the manifest `command`, not in run args.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Last `maxBytes` bytes of `text`, UTF-8-safe (never splits by char count). */
export function truncateTailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  return buf.subarray(buf.length - maxBytes).toString('utf-8');
}

/**
 * Resolve and execute one capability for a directory. Never throws for
 * manifest/permission/exec problems — they are reported as outcomes — but a
 * malformed manifest still surfaces as `automation-broken`, not a crash, so
 * callers (the scheduler) can fall back to reasoning.
 */
export function runCapabilityFromCwd(
  id: string,
  args: string[],
  cwd: string,
  tailBytes: number = DEFAULT_OUTPUT_TAIL_BYTES
): CapRunResult {
  let manifest: CapabilityManifest;
  try {
    manifest = loadCapabilityManifest(cwd);
  } catch (err) {
    if (err instanceof CapManifestError) {
      return broken(id, null, `manifest invalid: ${err.message}`, 0);
    }
    throw err;
  }
  return runCapability(manifest, id, args, cwd, tailBytes);
}

/** Execute a capability from an already-loaded manifest. */
export function runCapability(
  manifest: CapabilityManifest,
  id: string,
  args: string[],
  cwd: string,
  tailBytes: number = DEFAULT_OUTPUT_TAIL_BYTES
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
      duration_ms: 0,
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
      duration_ms: 0,
      reason: `capability '${id}' has lifecycle=shadow — only active entries execute`,
    };
  }

  for (const probe of entry.assumptions ?? []) {
    const result = evaluateProbe(probe, cwd);
    if (!result.ok) {
      return broken(
        id,
        entry.command,
        `assumption failed — ${result.reason}; command not run`,
        Date.now() - start
      );
    }
  }

  const commandLine = [entry.command, ...args.map(shellQuote)].join(' ');
  const timeoutMs = entry.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  // Captured (not `stdio: 'inherit'`) so a non-ok outcome can carry an
  // `output_tail` (issue #583 AC1) — re-emitted below so a human running
  // `cap run` directly still sees it (buffered, not streamed live).
  // `maxBuffer` explicit: `spawnSync`'s default is 1 MiB, and a chatty test
  // suite or verbose build legitimately exceeds that — without raising it,
  // an otherwise-passing command hits `res.error` (ENOBUFS) and gets
  // misclassified `automation-broken`, which the batch gate would then read
  // as a genuine inconclusive result rather than "the command produced a lot
  // of output" (review finding on #583).
  const res = spawnSync(commandLine, {
    shell: true,
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: MAX_CAPABILITY_OUTPUT_BYTES,
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  const durationMs = Date.now() - start;
  const classified = classifySpawnResult(
    res,
    id,
    commandLine,
    durationMs,
    cwd,
    timeoutMs,
    entry.minDurationMs ?? 0
  );
  if (classified.outcome !== 'ok') {
    classified.output_tail = truncateTailBytes(`${res.stdout ?? ''}${res.stderr ?? ''}`, tailBytes);
  }
  return classified;
}

/** Map a finished spawn to one of the three executed outcomes (ok / task-failed / automation-broken). */
function classifySpawnResult(
  res: ReturnType<typeof spawnSync>,
  id: string,
  commandLine: string,
  durationMs: number,
  cwd: string,
  timeoutMs: number,
  minDurationMs = 0
): CapRunResult {
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      return broken(id, commandLine, `command timed out after ${timeoutMs}ms`, durationMs);
    }
    const hint = code === 'ENOENT' ? ' — is the command on PATH from that directory?' : '';
    return broken(
      id,
      commandLine,
      `command failed to start: ${res.error.message} (cwd: ${cwd})${hint}`,
      durationMs
    );
  }
  if (res.status === SHELL_EXIT_COMMAND_NOT_FOUND) {
    return broken(
      id,
      commandLine,
      `command not found (exit ${SHELL_EXIT_COMMAND_NOT_FOUND})`,
      durationMs
    );
  }
  if (res.status === SHELL_EXIT_NOT_EXECUTABLE) {
    return broken(
      id,
      commandLine,
      `command not executable (exit ${SHELL_EXIT_NOT_EXECUTABLE})`,
      durationMs
    );
  }
  if (res.signal !== null) {
    // A timeout kill surfaces here (SIGTERM after the timeout) or as exit 128+N below
    return {
      outcome: 'automation-broken',
      capability: id,
      command: commandLine,
      exit_code: null,
      signal: res.signal,
      duration_ms: durationMs,
      reason: `abnormal termination: killed by ${res.signal}`,
    };
  }
  // sh reports a child killed by signal N as exit 128+N
  if (res.status !== null && res.status > SHELL_SIGNAL_EXIT_BASE) {
    return {
      outcome: 'automation-broken',
      capability: id,
      command: commandLine,
      exit_code: res.status,
      signal: null,
      duration_ms: durationMs,
      reason: `abnormal termination: exit ${res.status} (killed by signal ${res.status - SHELL_SIGNAL_EXIT_BASE})`,
    };
  }

  if (res.status === 0) {
    return {
      outcome: 'ok',
      capability: id,
      command: commandLine,
      exit_code: 0,
      signal: null,
      duration_ms: durationMs,
      reason: null,
    };
  }
  // #583 AC2: a non-zero exit that finished faster than the capability's
  // declared floor is more likely "the automation didn't really run" than a
  // genuine task failure — reclassify rather than hand the caller a false
  // task-failed.
  if (minDurationMs > 0 && durationMs < minDurationMs) {
    return {
      outcome: 'automation-broken',
      capability: id,
      command: commandLine,
      exit_code: res.status,
      signal: null,
      duration_ms: durationMs,
      reason: `exited ${res.status} after ${durationMs}ms — below min_duration_ms=${minDurationMs}ms; treated as automation-broken, not task-failed`,
    };
  }
  return {
    outcome: 'task-failed',
    capability: id,
    command: commandLine,
    exit_code: res.status,
    signal: null,
    duration_ms: durationMs,
    reason: null,
  };
}

function broken(
  id: string,
  command: string | null,
  reason: string,
  durationMs: number,
  overrides?: { exit_code?: number; signal?: string }
): CapRunResult {
  return {
    outcome: 'automation-broken',
    capability: id,
    command,
    exit_code: overrides?.exit_code ?? null,
    signal: overrides?.signal ?? null,
    duration_ms: durationMs,
    reason,
  };
}
