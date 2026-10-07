import { describe, expect, it } from 'vitest';
import { classifyPolicy } from '../classify';
import { policyRegions } from '../regions';

const file = (content: string, path = 'README.md') => ({ content, path, sha: 'a'.repeat(40) });
describe('CommonMark subset policy regions', () => {
  it.each([0, 1, 2, 3])('ends a contribution section at a sibling with %i spaces', (spaces) => {
    expect(
      classifyPolicy([
        file(`## Contributing\nRun tests.\n${' '.repeat(spaces)}## Usage\nAI is welcome.`),
      ]).ai
    ).toBe('silent');
  });
  it('does not accept four-space headings and retains enclosing scope across nested headings', () => {
    expect(classifyPolicy([file('    ## Contributing\nAI is banned.')]).ai).toBe('silent');
    const a = classifyPolicy([
      file(
        '## Contributing\nAI is welcome.\n### Contributor setup\nRun tests.\n### Restrictions\nAI is banned.\n## Usage\nAI is welcome.'
      ),
    ]);
    expect(a.ai).toBe('unclear');
    expect(a.citations.find((c) => c.ruleId === 'ai-ban-1')?.line).toBe(6);
  });
  it('accepts heading end-of-line, higher-level boundaries and multiple contribution regions', () => {
    const regions = policyRegions(
      file(
        '# Contributing\nNo AI.\n## Details\nNo PRs.\n#\nAI is welcome.\n# Contribution rules\nAssignment required.'
      )
    );
    expect(regions).toHaveLength(2);
    expect(regions[0].lines.map((line) => line.line)).toEqual([1, 2, 3, 4]);
    expect(regions[1].lines[1].line).toBe(8);
  });
  it('only closes matching fences with sufficient length and excludes all fenced text', () => {
    const text =
      '## Contributing\n````text\n~~~\n## Usage\n```\nAI is welcome.\n`````\nAI is banned.';
    const a = classifyPolicy([file(text)]);
    expect(a.ai).toBe('banned');
    expect(a.citations[0].line).toBe(8);
    expect(classifyPolicy([file('~~~\nAI is welcome.\n~~~~\nNo AI.', 'CONTRIBUTING.md')]).ai).toBe(
      'banned'
    );
    expect(classifyPolicy([file('```\nAI is banned.', 'CONTRIBUTING.md')]).ai).toBe('silent');
    expect(classifyPolicy([file('```invalid`info\nAI is banned.', 'CONTRIBUTING.md')]).ai).toBe(
      'banned'
    );
  });
  it('taints the whole touched README region on setext including prior restrictions', () => {
    expect(
      classifyPolicy([
        file(
          '## Contributing\nAI is banned.\nAssignment required.\nDetails\n===\nDraft optional.\nTemplate unchanged.'
        ),
      ])
    ).toMatchObject({
      ai: 'unclear',
      assignment: 'unclear',
      draftRequired: true,
      receiptBlockAllowed: false,
    });
    expect(classifyPolicy([file('## Contributing\nAI is banned.\nDetails\n---')]).ai).toBe(
      'unclear'
    );
    expect(classifyPolicy([file('Contributing\n===\nAI is banned.')]).ai).toBe('silent');
  });
  it('taints HTML blocks without mistaking their contents for heading boundaries', () => {
    const content =
      '## Contributing\nNo AI.\n<!--\n## Usage\nNo assignment.\n-->\nNo PRs.\n## Usage\nDraft optional.';
    expect(classifyPolicy([file(content)])).toMatchObject({
      ai: 'unclear',
      assignment: 'unclear',
      directPr: 'unclear',
      draftRequired: false,
    });
    expect(
      classifyPolicy([file('## Contributing\n<script>\n## Usage\nNo AI.\n</script>\nNo AI.')]).ai
    ).toBe('unclear');
    expect(
      classifyPolicy([file('## Contributing\n<div>\nNo AI.\n\n## Usage\nAI is welcome.')]).ai
    ).toBe('unclear');
    expect(
      classifyPolicy([file('<div>\n# Contributing\nNo AI.\n\n# Contributing\nNo AI.')]).ai
    ).toBe('banned');
  });
  it.each([
    '<!--\n```\n-->',
    '<script>\n~~~\n</script   >',
    '<?xml\n```\n?>',
    '<![CDATA[\n~~~\n]]>',
  ])('does not let fence-looking HTML content hide subsequent restrictions: %s', (html) => {
    expect(
      classifyPolicy([
        file(`## Contributing\n${html}\nNo AI.\nDraft required.\nNo extra sections.`),
      ])
    ).toMatchObject({ ai: 'unclear', draftRequired: true, receiptBlockAllowed: false });
    expect(classifyPolicy([file(`${html}\n## Contributing\nNo AI.`)]).ai).toBe('banned');
  });
  it.each([
    '<!DOCTYPE html>',
    '<?xml version="1.0"?>',
    '<![CDATA[placeholder]]>',
  ])('recognizes explicit HTML termination before a contribution heading: %s', (html) => {
    expect(classifyPolicy([file(`${html}\n## Contributing\nAI is banned.`)]).ai).toBe('banned');
  });
  it('retains policy-bearing headings and propagates ambiguity to their topics', () => {
    const content =
      '## Contributing\n### AI contributions are banned.\n### Draft required.\n### Do not modify the template.\n## Usage\nAI is welcome.';
    const a = classifyPolicy([file(content)]);
    expect(a).toMatchObject({ ai: 'banned', draftRequired: true, receiptBlockAllowed: false });
    expect(a.citations.find((citation) => citation.ruleId === 'ai-ban-1')?.line).toBe(2);
    expect(classifyPolicy([file(`${content.split('## Usage')[0]}Details\n===`)])).toMatchObject({
      ai: 'unclear',
      draftRequired: true,
      receiptBlockAllowed: false,
    });
    expect(classifyPolicy([file('## Contributing: no AI.')]).ai).toBe('banned');
  });
});
