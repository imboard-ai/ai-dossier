import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePathWithinCwd } from '../paths';

describe('validatePathWithinCwd', () => {
  it('should return resolved path for paths within cwd', () => {
    const result = validatePathWithinCwd('.');
    expect(result).toBe(process.cwd());
  });

  it('should return resolved path for subdirectories', () => {
    const result = validatePathWithinCwd('src');
    expect(result).toBe(resolve('src'));
  });

  it('should reject paths outside cwd', () => {
    expect(() => validatePathWithinCwd('/etc/passwd')).toThrow('Access denied');
  });

  it('should reject parent directory traversal', () => {
    expect(() => validatePathWithinCwd('../../etc/passwd')).toThrow('Access denied');
  });

  it('should allow cwd itself', () => {
    const result = validatePathWithinCwd(process.cwd());
    expect(result).toBe(process.cwd());
  });
});
