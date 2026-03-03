import { describe, expect, it } from 'vitest';
import { calculateChecksum } from '../checksum';
import type { LintConfig } from '../linter';
import { lintDossier } from '../linter';

function makeDossier(frontmatter: Record<string, unknown>, body = '# Test\n\n## Section\nContent') {
  const json = JSON.stringify(frontmatter, null, 2);
  return `---dossier\n${json}\n---\n${body}`;
}

const validFrontmatter = {
  dossier_schema_version: '1.0.0',
  title: 'Test Dossier',
  version: '1.0.0',
  protocol_version: '1.0',
  status: 'Stable',
  objective: 'Simple test dossier for verifying lint rules work correctly',
  risk_level: 'low',
  risk_factors: [],
  requires_approval: false,
  destructive_operations: [],
  checksum: {
    algorithm: 'sha256',
    hash: '', // Will be filled by helper
  },
};

function makeValidDossier(overrides: Record<string, unknown> = {}, body?: string) {
  const fm = { ...validFrontmatter, ...overrides };
  const content = body ?? '# Test\n\n## Section\nContent';
  if (fm.checksum && typeof fm.checksum === 'object') {
    (fm.checksum as any).hash = calculateChecksum(content);
  }
  return makeDossier(fm, content);
}

describe('lintDossier', () => {
  describe('schema-valid rule', () => {
    it('should pass for valid frontmatter', () => {
      const content = makeValidDossier();
      const result = lintDossier(content);
      const schemaErrors = result.diagnostics.filter((d) => d.ruleId === 'schema-valid');
      expect(schemaErrors).toHaveLength(0);
    });

    it('should detect missing required fields', () => {
      const content = makeDossier({ title: 'Incomplete' });
      const result = lintDossier(content);
      const schemaErrors = result.diagnostics.filter((d) => d.ruleId === 'schema-valid');
      expect(schemaErrors.length).toBeGreaterThan(0);
      expect(schemaErrors.some((d) => d.message.includes('dossier_schema_version'))).toBe(true);
    });

    it('should detect invalid status enum', () => {
      const content = makeValidDossier({ status: 'invalid' });
      const result = lintDossier(content);
      const schemaErrors = result.diagnostics.filter((d) => d.ruleId === 'schema-valid');
      expect(schemaErrors.some((d) => d.message.includes('status'))).toBe(true);
    });

    it('should accept valid schema-compliant status values', () => {
      for (const status of ['Draft', 'Stable', 'Deprecated', 'Experimental']) {
        const content = makeValidDossier({ status });
        const result = lintDossier(content);
        const schemaErrors = result.diagnostics.filter((d) => d.ruleId === 'schema-valid');
        expect(schemaErrors).toHaveLength(0);
      }
    });
  });

  describe('checksum-valid rule', () => {
    it('should pass when checksum matches', () => {
      const content = makeValidDossier();
      const result = lintDossier(content);
      const checksumErrors = result.diagnostics.filter((d) => d.ruleId === 'checksum-valid');
      expect(checksumErrors).toHaveLength(0);
    });

    it('should fail when checksum mismatches', () => {
      const fm = {
        ...validFrontmatter,
        checksum: {
          algorithm: 'sha256',
          hash: 'badbad0000000000000000000000000000000000000000000000000000000000',
        },
      };
      const content = makeDossier(fm);
      const result = lintDossier(content);
      const checksumErrors = result.diagnostics.filter((d) => d.ruleId === 'checksum-valid');
      expect(checksumErrors).toHaveLength(1);
      expect(checksumErrors[0].message).toContain('Checksum mismatch');
    });

    it('should fail when checksum is missing', () => {
      const fm = { ...validFrontmatter };
      delete (fm as any).checksum;
      const content = makeDossier(fm);
      const result = lintDossier(content);
      const checksumErrors = result.diagnostics.filter((d) => d.ruleId === 'checksum-valid');
      expect(checksumErrors.some((d) => d.message.includes('Missing checksum'))).toBe(true);
    });
  });

  describe('semver-version rule', () => {
    it('should pass for valid semver', () => {
      const content = makeValidDossier({ version: '1.2.3' });
      const result = lintDossier(content);
      const semverErrors = result.diagnostics.filter((d) => d.ruleId === 'semver-version');
      expect(semverErrors).toHaveLength(0);
    });

    it('should pass for semver with prerelease', () => {
      const content = makeValidDossier({ version: '1.0.0-beta.1' });
      const result = lintDossier(content);
      const semverErrors = result.diagnostics.filter((d) => d.ruleId === 'semver-version');
      expect(semverErrors).toHaveLength(0);
    });

    it('should fail for invalid semver', () => {
      const content = makeValidDossier({ version: 'not-semver' });
      const result = lintDossier(content);
      const semverErrors = result.diagnostics.filter((d) => d.ruleId === 'semver-version');
      expect(semverErrors).toHaveLength(1);
      expect(semverErrors[0].message).toContain('Invalid semver');
    });
  });

  describe('risk-level-consistency rule', () => {
    it('should warn when low risk has destructive operations', () => {
      const content = makeValidDossier({
        risk_level: 'low',
        destructive_operations: ['Deletes all data'],
      });
      const result = lintDossier(content);
      const riskWarnings = result.diagnostics.filter((d) => d.ruleId === 'risk-level-consistency');
      expect(riskWarnings).toHaveLength(1);
      expect(riskWarnings[0].severity).toBe('warning');
    });

    it('should not warn when low risk has no destructive operations', () => {
      const content = makeValidDossier({
        risk_level: 'low',
        destructive_operations: [],
      });
      const result = lintDossier(content);
      const riskWarnings = result.diagnostics.filter((d) => d.ruleId === 'risk-level-consistency');
      expect(riskWarnings).toHaveLength(0);
    });

    it('should not warn when high risk has destructive operations', () => {
      const content = makeValidDossier({
        risk_level: 'high',
        destructive_operations: ['Deletes all data'],
      });
      const result = lintDossier(content);
      const riskWarnings = result.diagnostics.filter((d) => d.ruleId === 'risk-level-consistency');
      expect(riskWarnings).toHaveLength(0);
    });
  });

  describe('tools-check-command rule', () => {
    it('should warn when tool has no check_command', () => {
      const content = makeValidDossier({
        tools_required: [{ name: 'docker' }],
      });
      const result = lintDossier(content);
      const toolWarnings = result.diagnostics.filter((d) => d.ruleId === 'tools-check-command');
      expect(toolWarnings).toHaveLength(1);
      expect(toolWarnings[0].message).toContain('docker');
    });

    it('should not warn when tool has check_command', () => {
      const content = makeValidDossier({
        tools_required: [{ name: 'docker', check_command: 'docker --version' }],
      });
      const result = lintDossier(content);
      const toolWarnings = result.diagnostics.filter((d) => d.ruleId === 'tools-check-command');
      expect(toolWarnings).toHaveLength(0);
    });

    it('should not warn when no tools_required', () => {
      const content = makeValidDossier();
      const result = lintDossier(content);
      const toolWarnings = result.diagnostics.filter((d) => d.ruleId === 'tools-check-command');
      expect(toolWarnings).toHaveLength(0);
    });
  });

  describe('objective-quality rule', () => {
    it('should info when objective is too short', () => {
      const content = makeValidDossier({ objective: 'Short obj.' }); // 10 chars, meets schema min
      const result = lintDossier(content);
      const objInfo = result.diagnostics.filter((d) => d.ruleId === 'objective-quality');
      expect(objInfo.some((d) => d.message.includes('very short'))).toBe(true);
    });

    it('should info when objective starts with non-verb', () => {
      const content = makeValidDossier({
        objective: 'This is a test objective that describes something',
      });
      const result = lintDossier(content);
      const objInfo = result.diagnostics.filter((d) => d.ruleId === 'objective-quality');
      expect(objInfo.some((d) => d.message.includes('start with a verb'))).toBe(true);
    });

    it('should not warn for good objectives', () => {
      const content = makeValidDossier({
        objective: 'Configure the application for production deployment',
      });
      const result = lintDossier(content);
      const objInfo = result.diagnostics.filter((d) => d.ruleId === 'objective-quality');
      expect(objInfo).toHaveLength(0);
    });
  });

  describe('required-sections rule', () => {
    it('should warn when body is empty', () => {
      const content = makeValidDossier({}, '');
      const result = lintDossier(content);
      const sectionWarnings = result.diagnostics.filter((d) => d.ruleId === 'required-sections');
      expect(sectionWarnings).toHaveLength(1);
      expect(sectionWarnings[0].message).toContain('empty');
    });

    it('should warn when body has no ## headings', () => {
      const content = makeValidDossier({}, 'Just some text without headings');
      const result = lintDossier(content);
      const sectionWarnings = result.diagnostics.filter((d) => d.ruleId === 'required-sections');
      expect(sectionWarnings).toHaveLength(1);
      expect(sectionWarnings[0].message).toContain('no ## headings');
    });

    it('should pass when body has ## headings', () => {
      const content = makeValidDossier({}, '# Title\n\n## Section\nContent');
      const result = lintDossier(content);
      const sectionWarnings = result.diagnostics.filter((d) => d.ruleId === 'required-sections');
      expect(sectionWarnings).toHaveLength(0);
    });
  });

  describe('config overrides', () => {
    it('should disable rules when set to off', () => {
      const fm = { ...validFrontmatter };
      delete (fm as any).checksum;
      const content = makeDossier(fm);
      const config: LintConfig = { rules: { 'checksum-valid': 'off' } };
      const result = lintDossier(content, config);
      const checksumErrors = result.diagnostics.filter((d) => d.ruleId === 'checksum-valid');
      expect(checksumErrors).toHaveLength(0);
    });

    it('should escalate severity when configured', () => {
      const content = makeValidDossier({
        tools_required: [{ name: 'docker' }],
      });
      const config: LintConfig = { rules: { 'tools-check-command': 'error' } };
      const result = lintDossier(content, config);
      const toolErrors = result.diagnostics.filter((d) => d.ruleId === 'tools-check-command');
      expect(toolErrors).toHaveLength(1);
      expect(toolErrors[0].severity).toBe('error');
    });
  });

  describe('result counts', () => {
    it('should correctly count errors, warnings, and info', () => {
      const content = makeValidDossier({
        objective: 'This is a test objective that describes something',
        tools_required: [{ name: 'docker' }],
      });
      const result = lintDossier(content);
      expect(result.errorCount).toBe(0);
      expect(result.warningCount).toBeGreaterThanOrEqual(1); // tools-check-command
      expect(result.infoCount).toBeGreaterThanOrEqual(1); // objective-quality
    });
  });
});
