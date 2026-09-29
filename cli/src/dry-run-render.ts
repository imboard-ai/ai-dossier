/**
 * Terminal rendering of a static dry-run plan (`run --dry-run`, issue #20).
 *
 * Colors: green = read-only, yellow = local writes, red = remote or destructive.
 * All color goes through the shared, NO_COLOR-aware `paint` helper.
 */

import type { DryRunCommand, DryRunKind, DryRunPlan } from '@ai-dossier/core';
import { paint } from './color';

/** How many entries to print per group before pointing at --plan-out. */
export const RENDER_LIMIT = 12;

const GROUPS: Array<{
  kinds: DryRunKind[];
  label: string;
  color: 'green' | 'yellow' | 'red';
  mark: string;
}> = [
  { kinds: ['read'], label: 'Read-only', color: 'green', mark: '[read]' },
  { kinds: ['local_write'], label: 'Local-write', color: 'yellow', mark: '[local]' },
  {
    kinds: ['remote', 'destructive'],
    label: 'Remote / destructive',
    color: 'red',
    mark: '[remote]',
  },
];

function clip(s: string, max = 110): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function commandTag(c: DryRunCommand): string {
  if (c.kind === 'destructive') return ' (destructive)';
  if (!c.recognized) return ' (unrecognized executable)';
  return '';
}

export function renderDryRun(plan: DryRunPlan, llmCommand?: string | null): string[] {
  const out: string[] = [];
  const levelColor = plan.level === 'low' ? 'green' : plan.level === 'medium' ? 'yellow' : 'red';

  out.push(
    paint('bright', 'Static preview') +
      " - derived from the dossier's declared metadata and code blocks;"
  );
  out.push('the executing agent may take other actions. Not a safety guarantee.');
  out.push('');
  out.push(
    `Risk score: ${paint(levelColor, `${plan.risk_score}/100 (${plan.level})`)}   declared risk_level: ${plan.dossier.declared_risk_level ?? 'unset'}`
  );
  for (const b of plan.score_breakdown) out.push(`   +${b.points}  ${b.component}`);
  out.push('');

  for (const g of GROUPS) {
    const items = plan.commands.filter((c) => g.kinds.includes(c.kind));
    out.push(paint(g.color, `${g.mark} ${g.label} commands (${items.length})`));
    for (const c of items.slice(0, RENDER_LIMIT)) {
      out.push(paint(g.color, `   ${clip(c.command)}${commandTag(c)}`));
    }
    if (items.length > RENDER_LIMIT) {
      out.push(`   ... and ${items.length - RENDER_LIMIT} more (full list: --plan-out <file>)`);
    }
  }
  out.push('');

  out.push(paint('yellow', `Files touched (${plan.files.length})`));
  for (const f of plan.files.slice(0, RENDER_LIMIT)) {
    const color = f.operation === 'delete' ? 'red' : 'yellow';
    out.push(paint(color, `   ${f.operation.padEnd(6)} ${clip(f.path)}`));
  }
  if (plan.files.length > RENDER_LIMIT)
    out.push(`   ... and ${plan.files.length - RENDER_LIMIT} more`);

  out.push(paint('red', `Network / remote calls (${plan.network.length})`));
  for (const n of plan.network.slice(0, RENDER_LIMIT)) {
    out.push(
      paint(
        'red',
        `   ${n.tool} ${clip(n.target, 60)}${n.mutates ? ' (changes remote state)' : ' (read)'}`
      )
    );
  }
  if (plan.network.length > RENDER_LIMIT)
    out.push(`   ... and ${plan.network.length - RENDER_LIMIT} more`);

  out.push(paint('green', `Environment variables read (${plan.env.length})`));
  if (plan.env.length > 0) out.push(paint('green', `   ${plan.env.map((e) => e.name).join(', ')}`));

  if (plan.declared.risk_factors.length > 0 || plan.declared.destructive_operations.length > 0) {
    out.push('');
    out.push('Declared by the dossier:');
    if (plan.declared.risk_factors.length > 0) {
      out.push(`   risk_factors: ${plan.declared.risk_factors.join(', ')}`);
    }
    for (const d of plan.declared.destructive_operations)
      out.push(paint('red', `   destructive: ${clip(d)}`));
  }

  if (llmCommand !== undefined) {
    out.push('');
    out.push(`Would run: ${llmCommand ?? 'No LLM detected - would show error'}`);
  }
  return out;
}

/** JSON written by `--plan-out`: the core plan plus how the CLI would launch it. */
export interface PlanFile extends DryRunPlan {
  execution: { file: string; llm: string; command: string | null };
}

export function buildPlanFile(plan: DryRunPlan, execution: PlanFile['execution']): PlanFile {
  return { ...plan, execution };
}
