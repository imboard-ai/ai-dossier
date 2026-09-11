#!/usr/bin/env node
/**
 * Compare two effort/variant settings for a dispatch profile.
 *
 * The default is a dry run: it resolves and prints the exact argv that would
 * be spawned. Pass --run only when provider credentials are available. The
 * probe sends the same prompt to two tiers using the same model and compares
 * output tokens, which is the useful signal for reasoning effort (the input
 * prompt is identical by construction).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { usageParserFor } from '@ai-dossier/core';
import { buildTierCommand, resolveProfiledDispatch, tierExecutors } from '@ai-dossier/sched';

const TIER_ORDER = ['mechanical', 'mid', 'strong'];
const DEFAULT_PROJECT = 'imboard-ai-imboard-monorepo';
const DEFAULT_TASK =
  'Return exactly one sentence explaining why a dependency graph prevents circular delivery work.';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const EFFORT_RANK = new Map([
  ['minimal', 0],
  ['low', 1],
  ['medium', 2],
  ['high', 3],
  ['max', 4],
]);

function optionValue(command, options) {
  for (let i = command.length - 1; i >= 0; i--) {
    const item = command[i];
    for (const option of options) {
      if (item.startsWith(`${option}=`)) return item.slice(option.length + 1) || null;
      if (item === option) {
        const value = command[i + 1];
        return value !== undefined && !value.startsWith('--') ? value : null;
      }
    }
  }
  return null;
}

/**
 * Return the strongest same-model comparison available in a resolved profile.
 * A comparison is only useful when the command actually carries a differing
 * effort/variant value; comparing different models would confound the result.
 */
export function selectEffortPair(executors) {
  const candidates = [];
  for (let left = 0; left < TIER_ORDER.length; left++) {
    for (let right = left + 1; right < TIER_ORDER.length; right++) {
      const lowTier = TIER_ORDER[left];
      const highTier = TIER_ORDER[right];
      const low = executors[lowTier];
      const high = executors[highTier];
      if (low.model === null || low.model !== high.model) continue;

      for (const setting of ['effort', 'variant']) {
        const lowValue = low[setting];
        const highValue = high[setting];
        if (
          typeof lowValue !== 'string' ||
          typeof highValue !== 'string' ||
          lowValue === highValue
        ) {
          continue;
        }
        const lowRank = EFFORT_RANK.get(lowValue.toLowerCase());
        const highRank = EFFORT_RANK.get(highValue.toLowerCase());
        const distance =
          lowRank === undefined || highRank === undefined ? 0 : Math.abs(highRank - lowRank);
        candidates.push({
          lowTier:
            lowRank === undefined || highRank === undefined || lowRank <= highRank
              ? lowTier
              : highTier,
          highTier:
            lowRank === undefined || highRank === undefined || lowRank <= highRank
              ? highTier
              : lowTier,
          setting,
          lowValue:
            lowRank === undefined || highRank === undefined || lowRank <= highRank
              ? lowValue
              : highValue,
          highValue:
            lowRank === undefined || highRank === undefined || lowRank <= highRank
              ? highValue
              : lowValue,
          distance,
        });
      }
    }
  }

  candidates.sort((a, b) => b.distance - a.distance);
  return candidates[0] ?? null;
}

export function schedulerConfigPath(project, home = homedir()) {
  return join(home, '.dossier', 'sched', project, 'config.json');
}

function parseArgs(argv) {
  const args = {
    project: DEFAULT_PROJECT,
    profile: [],
    task: DEFAULT_TASK,
    issue: 0,
    cwd: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    run: false,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--project':
        args.project = value();
        break;
      case '--profile':
        args.profile.push(value());
        break;
      case '--task':
        args.task = value();
        break;
      case '--issue':
        args.issue = Number(value());
        if (!Number.isInteger(args.issue) || args.issue < 0) {
          throw new Error('--issue must be a non-negative integer');
        }
        break;
      case '--cwd':
        args.cwd = value();
        break;
      case '--timeout-ms':
        args.timeoutMs = Number(value());
        if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0) {
          throw new Error('--timeout-ms must be a positive integer');
        }
        break;
      case '--out':
        args.out = value();
        break;
      case '--run':
        args.run = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return args;
}

function help() {
  return [
    'Usage: node scripts/sched-fleet/probe-effort.mjs [options]',
    '',
    `  --project <slug>       scheduler project (default: ${DEFAULT_PROJECT})`,
    '  --profile <name>       profile to probe; repeat or omit for all profiles',
    `  --task <prompt>        identical prompt for both runs (default: ${DEFAULT_TASK})`,
    '  --issue <n>            substitute {issue} in command templates (default: 0)',
    '  --cwd <path>           provider working directory (default: current directory)',
    `  --timeout-ms <n>       per-run timeout (default: ${DEFAULT_TIMEOUT_MS})`,
    '  --run                  actually invoke providers; otherwise print a dry run',
    '  --out <path>           also write the JSON result to this path',
  ].join('\n');
}

function readConfig(path) {
  if (!existsSync(path)) throw new Error(`scheduler config not found: ${path}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`scheduler config is not valid JSON: ${path} (${error.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`scheduler config must be an object: ${path}`);
  }
  return parsed;
}

function commandDetails(command) {
  return {
    command,
    agent: basename(command[0] ?? ''),
    effort: optionValue(command, ['--effort', '--reasoning-effort']),
    variant: optionValue(command, ['--variant']),
  };
}

export function prepareProfile(config, profile, issue = 0) {
  const resolved = resolveProfiledDispatch(config, profile);
  const executors = tierExecutors(resolved);
  const pair = selectEffortPair(executors);
  if (pair === null) {
    throw new Error(
      `profile '${profile}' has no same-model tier pair with different --effort/--variant values`
    );
  }
  const lowCommand = buildTierCommand(resolved, pair.lowTier, issue);
  const highCommand = buildTierCommand(resolved, pair.highTier, issue);
  return {
    profile,
    setting: pair.setting,
    low: {
      tier: pair.lowTier,
      value: pair.lowValue,
      model: executors[pair.lowTier].model,
      ...commandDetails(lowCommand),
    },
    max: {
      tier: pair.highTier,
      value: pair.highValue,
      model: executors[pair.highTier].model,
      ...commandDetails(highCommand),
    },
  };
}

function totalTokens(usage) {
  if (usage === null) return null;
  if (usage.input_tokens === null || usage.output_tokens === null) return null;
  return usage.input_tokens + usage.output_tokens;
}

function opencodeTotalTokens(stdout) {
  let total = 0;
  let sawTotal = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      !event ||
      typeof event !== 'object' ||
      event.type !== 'step_finish' ||
      !event.part ||
      typeof event.part !== 'object' ||
      !event.part.tokens ||
      typeof event.part.tokens !== 'object'
    ) {
      continue;
    }
    const value = event.part.tokens.total;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      total += value;
      sawTotal = true;
    }
  }
  return sawTotal ? total : null;
}

/**
 * Prefer the provider's own total when it exposes one. OpenCode reports
 * reasoning separately from output, so input+output alone would hide the
 * setting this probe is intended to validate.
 */
export function measuredTokens(agent, stdout, usage) {
  return (agent === 'opencode' ? opencodeTotalTokens(stdout) : null) ?? totalTokens(usage);
}

function runCommand(spec, task, cwd, timeoutMs) {
  const result = spawnSync(spec.command[0], spec.command.slice(1), {
    cwd,
    input: task,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error) throw new Error(`${spec.tier} run failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${spec.tier} run exited with status ${String(result.status)}`);
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const usage = usageParserFor(spec.command[0])(stdout);
  const parsedTotalTokens = totalTokens(usage);
  const measuredTotalTokens = measuredTokens(basename(spec.command[0]), stdout, usage);
  if (usage === null || measuredTotalTokens === null) {
    throw new Error(
      `${spec.tier} run produced no parseable token usage (exit=${String(result.status)})`
    );
  }
  return {
    exit_code: result.status,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: parsedTotalTokens,
    measured_tokens: measuredTotalTokens,
    cost_usd: usage.total_cost_usd,
  };
}

export function runPreparedProbe(prepared, task, cwd, timeoutMs) {
  const low = runCommand(prepared.low, task, cwd, timeoutMs);
  const max = runCommand(prepared.max, task, cwd, timeoutMs);
  return {
    ...prepared,
    low: { ...prepared.low, result: low },
    max: { ...prepared.max, result: max },
    token_delta: max.measured_tokens - low.measured_tokens,
    measurable_difference: max.measured_tokens !== low.measured_tokens,
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(help());
    return 0;
  }
  const configPath = schedulerConfigPath(args.project);
  const config = readConfig(configPath);
  const configuredProfiles = Object.keys(config.dispatch?.dispatch_profiles ?? {}).sort();
  const profiles = args.profile.length > 0 ? args.profile : configuredProfiles;
  if (profiles.length === 0) throw new Error('no dispatch profiles are configured');

  const report = {
    project: args.project,
    config: configPath,
    task: args.task,
    dry_run: !args.run,
    probes: [],
  };
  for (const profile of profiles) {
    try {
      const prepared = prepareProfile(config, profile, args.issue);
      report.probes.push(
        args.run ? runPreparedProbe(prepared, args.task, args.cwd, args.timeoutMs) : prepared
      );
    } catch (error) {
      report.probes.push({
        profile,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const serialized = JSON.stringify(report, null, 2);
  if (args.out !== null) writeFileSync(args.out, `${serialized}\n`);
  console.log(serialized);
  if (report.probes.some((probe) => probe.error !== undefined)) return 1;
  if (args.run && report.probes.some((probe) => !probe.measurable_difference)) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`probe-effort: ${error.message}`);
    process.exitCode = 1;
  }
}
