/** "Dossier: Dry-run preview" — text rendering of core's `analyzeDryRun` static plan. */
import { analyzeDryRun, DRY_RUN_DISCLAIMER, type DryRunPlan } from '@ai-dossier/core';

export function dryRunContent(content: string): DryRunPlan {
  return analyzeDryRun(content);
}

function section(title: string, rows: string[]): string[] {
  return rows.length ? ['', `${title} (${rows.length})`, ...rows.map((r) => `  ${r}`)] : [];
}

export function formatDryRun(plan: DryRunPlan): string {
  const out = [
    `Dry-run preview: ${plan.dossier.title} v${plan.dossier.version}`,
    `NOTE: ${plan.disclaimer || DRY_RUN_DISCLAIMER}`,
    '',
    `Risk score: ${plan.risk_score}/100 (${plan.level}); declared risk_level: ${plan.dossier.declared_risk_level ?? 'none'}`,
    `Requires approval: ${plan.declared.requires_approval ? 'yes' : 'no'}`,
  ];
  if (plan.declared_vs_observed?.mismatch) {
    out.push(
      `WARNING: declares ${plan.declared_vs_observed.declared_level ?? 'no risk_level'}, code blocks show ${plan.declared_vs_observed.observed_level}; the score follows observed behaviour.`
    );
  }
  if ((plan.unanalyzed_fences?.length ?? 0) > 0) {
    out.push(
      `WARNING: ${plan.unanalyzed_fences.length} code block(s) in a language that is not analysed (${[...new Set(plan.unanalyzed_fences.map((f) => f.lang || 'unlabeled'))].join(', ')}); not reflected in the score.`
    );
  }
  out.push(
    ...section(
      'Commands',
      plan.commands.map((c) => `L${c.line} [${c.kind}] ${c.command}`)
    )
  );
  out.push(
    ...section(
      'Files touched',
      plan.files.map((f) => `L${f.line} ${f.operation} ${f.path}`)
    )
  );
  out.push(
    ...section(
      'Network',
      plan.network.map((n) => `L${n.line} ${n.tool} -> ${n.target}${n.mutates ? ' (mutates)' : ''}`)
    )
  );
  out.push(
    ...section(
      'Environment variables read',
      plan.env.map((e) => `L${e.line} ${e.name}`)
    )
  );
  out.push(
    ...section(
      'Score breakdown',
      plan.score_breakdown.map((s) => `${s.component}: ${s.points >= 0 ? '+' : ''}${s.points}`)
    )
  );
  if (plan.declared.destructive_operations.length) {
    out.push(...section('Declared destructive operations', plan.declared.destructive_operations));
  }
  out.push('', `NOTE: ${plan.disclaimer || DRY_RUN_DISCLAIMER}`);
  return out.join('\n');
}
