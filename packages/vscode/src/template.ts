/** "New from template": a minimal dossier that passes lint out of the box, checksum included. */
import { calculateChecksum } from '@ai-dossier/core';

export interface TemplateInput {
  title: string;
  objective: string;
  /** YYYY-MM-DD */
  date: string;
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'new-dossier';
}

export function buildBody(title: string): string {
  return `# ${title}

## Objective

Describe the single outcome this dossier achieves.

## Prerequisites

- List tools, access, and state that must exist before starting.

## Context to Gather

1. What the agent must inspect before acting.

## Decision Points

- Where the agent must choose between paths, and how to choose.

## Constraints

- Things the agent must not do.

## Known Pitfalls

- Failure modes seen before, and how to avoid them.

## Validation

\`\`\`bash
# commands that prove the work succeeded
\`\`\`

## Troubleshooting

- Symptom: cause and fix.
`;
}

export function buildDossier({ title, objective, date }: TemplateInput): string {
  const body = buildBody(title);
  const frontmatter = {
    dossier_schema_version: '1.0.0',
    title,
    version: '0.1.0',
    protocol_version: '1.0',
    status: 'Draft',
    last_updated: date,
    objective,
    category: ['development'],
    tags: [],
    tools_required: [],
    risk_level: 'low',
    risk_factors: [],
    requires_approval: false,
    destructive_operations: [],
    checksum: { algorithm: 'sha256', hash: calculateChecksum(body) },
  };
  return `---dossier\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;
}
