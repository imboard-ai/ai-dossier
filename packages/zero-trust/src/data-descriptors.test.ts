import { describe, expect, it } from 'vitest';
import { dataDescriptors } from './data-descriptors';

describe('lossless data descriptors', () => {
  it('preserves dense arrays and plain data without reading getters', () => {
    expect(dataDescriptors([1, 2]).keys).toEqual(['0', '1', 'length']);
    expect(dataDescriptors({ a: 1 }).descriptors.a.value).toBe(1);
    expect(dataDescriptors(Object.create(null), true).array).toBe(false);
    let called = false;
    expect(() =>
      dataDescriptors({
        get a() {
          called = true;
          return 1;
        },
      })
    ).toThrow();
    expect(called).toBe(false);
  });
  it('rejects lossy, opaque and oversized containers', () => {
    class Data {}
    for (const value of [
      new Data(),
      new Map(),
      new Date(),
      Array(1),
      Object.assign([], { extra: 1 }),
      Object.create(null),
      { [Symbol('x')]: 1 },
      Object.defineProperty({}, 'x', { value: 1 }),
      Object.defineProperty({}, 'length', { value: 1 }),
      Object.assign(Array(1), { extra: 1 }),
      Array(20001),
      Object.fromEntries(Array.from({ length: 20001 }, (_, n) => [String(n), n])),
    ])
      expect(() => dataDescriptors(value)).toThrow();
  });
});
