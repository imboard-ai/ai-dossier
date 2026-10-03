/**
 * `cap init` scaffolding and the enqueue-time gate preflight (#645).
 *
 * A repo with no capability manifest batches with every member gate silently
 * skipped (`gate-skipped:<id>`, #626). Two halves fix the silence without
 * reintroducing #625's hard block: `scaffoldManifest` writes a starting
 * manifest from the detected project environment, and `gateGapWarning` is the
 * warning `sched enqueue` prints before any agent is dispatched.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectProjectEnv, type PackageManager } from '@ai-dossier/worktree-pool';
import {
  AUTOMATION_DIR,
  type CapabilityManifest,
  GATES_NONE_DECLARED_ON_PURPOSE,
  MANIFEST_FILE,
} from './capability';

/** The fixed pair `runIncrementalGate` (packages/sched) evaluates after every batch member. */
export const MEMBER_GATE_CAPABILITIES = ['typecheck.run', 'test.focused'] as const;

/** Env var equivalent of `sched enqueue --skip-gate-check`. */
export const SKIP_GATE_CHECK_ENV = 'DOSSIER_SKIP_GATE_CHECK';

/** Gate ids the manifest does not declare (any lifecycle counts as a deliberate declaration). */
export function missingGateCapabilities(manifest: CapabilityManifest): string[] {
  return MEMBER_GATE_CAPABILITIES.filter((id) => manifest.capabilities[id] === undefined);
}

/**
 * The enqueue-time warning for undeclared member-gate capabilities, or `null`
 * when the manifest declares them all. Warning only — never a refusal.
 */
export function gateGapWarning(manifest: CapabilityManifest): string | null {
  if (manifest.gates === GATES_NONE_DECLARED_ON_PURPOSE) return null; // #895: durable opt-out
  const missing = missingGateCapabilities(manifest);
  if (missing.length === 0) return null;
  const where =
    manifest.path === null
      ? `no capability manifest (${AUTOMATION_DIR}/${MANIFEST_FILE})`
      : `${manifest.path} does not declare them`;
  return (
    `⚠ Batch member gate capabilities undeclared: ${missing.join(', ')} — ${where}.\n` +
    `  Every member will land with those gates SKIPPED (journalled gate-skipped:<id>), unverified.\n` +
    `  Fix:     ai-dossier cap init          # scaffold a manifest from the detected project\n` +
    `  Opt out: --skip-gate-check (or ${SKIP_GATE_CHECK_ENV}=1) once, or durably add\n` +
    `           gates: ${GATES_NONE_DECLARED_ON_PURPOSE}   # to the manifest, if this repo deliberately declares nothing.`
  );
}

interface ScriptInfo {
  scripts: Record<string, string>;
}

function readScripts(dir: string): ScriptInfo {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    const raw = parsed?.scripts;
    const scripts: Record<string, string> = {};
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') scripts[k] = v;
    }
    return { scripts };
  } catch {
    return { scripts: {} };
  }
}

/** `npm test` / `npm run build` / `pnpm test` — the shortest correct invocation. */
function runScript(pm: PackageManager, script: string): string {
  if (script === 'test' && pm !== 'bun') return `${pm} test`;
  return `${pm} run ${script}`;
}

interface Entry {
  id: string;
  command: string | null;
  description: string;
  source: string;
  todo: string;
}

function renderEntry(e: Entry): string {
  const lines: string[] = [];
  if (e.command === null) {
    lines.push(
      `  # TODO ${e.id}: ${e.todo}`,
      `  # ${e.id}:`,
      '  #   command: <fill in>',
      '  #   lifecycle: active',
      `  #   description: ${e.description}`
    );
  } else {
    lines.push(
      `  # ${e.source}`,
      `  ${e.id}:`,
      `    command: ${JSON.stringify(e.command)}`,
      '    lifecycle: active',
      `    description: ${JSON.stringify(e.description)}`
    );
  }
  return lines.join('\n');
}

/**
 * Manifest text for the project at `dir`, derived from `detectProjectEnv`
 * (package manager, install, build) and the `scripts` in package.json. A gate
 * with no detectable command is emitted as a commented TODO stub — the id then
 * stays undeclared, so the enqueue preflight keeps warning until an operator
 * fills it in (a guessed command that fails would evict good members).
 */
export function scaffoldManifest(dir: string): string {
  const env = detectProjectEnv(dir);
  const { scripts } = readScripts(dir);
  const has = (s: string) => typeof scripts[s] === 'string';

  const typecheckScript = ['typecheck', 'type-check', 'tsc'].find(has);
  const typecheck: Entry = {
    id: 'typecheck.run',
    command: typecheckScript
      ? runScript(env.pm, typecheckScript)
      : env.buildCmd
        ? env.buildCmd.join(' ')
        : null,
    description: 'Typecheck (batch member gate, run first)',
    source: typecheckScript
      ? `detected: package.json script "${typecheckScript}"`
      : `detected: build script (${env.buildCmd?.join(' ')}) — no typecheck script, so the build is the typecheck`,
    todo: 'no typecheck/build script found in package.json — declare the command that typechecks this repo',
  };
  const testCmd = has('test') ? runScript(env.pm, 'test') : null;
  const testFocused: Entry = {
    id: 'test.focused',
    command: testCmd,
    description: 'Per-member test gate (batch member gate, run after typecheck.run)',
    source:
      'detected: package.json script "test" — narrow it to a diff-scoped run if the suite is slow',
    todo: 'no "test" script found in package.json — declare the command that runs this repo\'s tests',
  };
  const testFull: Entry = {
    id: 'test.full',
    command: testCmd,
    description: 'Full test suite (aggregate batch gate fallback)',
    source: 'detected: package.json script "test"',
    todo: 'declare the full-suite command',
  };
  const install: Entry = {
    id: 'dependencies.install',
    command: env.installCmd.join(' '),
    description: 'Install project dependencies',
    source: `detected: ${env.pm} (${env.lockfile})`,
    todo: '',
  };
  const lint: Entry | null = has('lint')
    ? {
        id: 'lint.run',
        command: runScript(env.pm, 'lint'),
        description: 'Lint check',
        source: 'detected: package.json script "lint"',
        todo: '',
      }
    : null;

  const entries = [typecheck, testFocused, testFull, install, ...(lint ? [lint] : [])];
  return `${[
    `# Capability manifest scaffolded by \`ai-dossier cap init\` (#645) — EDIT, don't accept blindly.`,
    '#',
    `# Detected package manager: ${env.pm}`,
    '#',
    '# typecheck.run and test.focused are the batch member gate: run after every batch',
    '# member reports done. Undeclared, the gate is skipped and members land unverified.',
    '# Commands below were inferred from package.json; confirm each one passes on a clean',
    '# checkout. Commented TODO stubs mean nothing was detected — fill them in.',
    '# Reference: docs/reference/capabilities.md',
    'version: 1',
    '',
    'capabilities:',
    entries.map(renderEntry).join('\n\n'),
  ].join('\n')}\n`;
}

export interface InitResult {
  path: string;
  /** `created`, or `exists` when a manifest was already there (left untouched). */
  status: 'created' | 'exists';
}

/** Write the scaffold to `<root>/.dossier/automation/manifest.yaml` unless one already exists. */
export function initManifest(root: string, projectDir: string): InitResult {
  const target = path.join(root, AUTOMATION_DIR, MANIFEST_FILE);
  if (fs.existsSync(target)) return { path: target, status: 'exists' };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 'wx': never clobber even if a manifest appears between the check and the write.
  try {
    fs.writeFileSync(target, scaffoldManifest(projectDir), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { path: target, status: 'exists' };
    throw err;
  }
  return { path: target, status: 'created' };
}
