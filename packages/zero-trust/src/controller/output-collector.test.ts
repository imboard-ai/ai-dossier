import { describe, expect, it } from 'vitest';
import { DEFAULT_OUTPUT_CAP_BYTES, OutputCollector } from './output-collector';

describe('OutputCollector', () => {
  it('keeps strings and buffers in arrival order and skips empty output', () => {
    const collector = new OutputCollector();
    collector.append('stdout');
    collector.append(Buffer.from('report'));
    collector.append('');
    collector.append(null);
    collector.append(undefined);
    expect(collector.outputs()).toEqual(['stdout', 'report']);
    expect(collector.bytes).toBe(12);
    expect(collector.truncated).toBe(false);
    expect(collector.capBytes).toBe(DEFAULT_OUTPUT_CAP_BYTES);
  });

  it('stops at the cap and marks the collection truncated', () => {
    const collector = new OutputCollector(8);
    collector.append('12345');
    collector.append('67890');
    collector.append('more');
    expect(collector.outputs()).toEqual(['12345', '678']);
    expect(collector.bytes).toBe(8);
    expect(collector.truncated).toBe(true);
  });

  it('a chunk that exactly fills the cap is not truncation', () => {
    const collector = new OutputCollector(4);
    collector.append('abcd');
    expect(collector.truncated).toBe(false);
  });

  it('returns a frozen copy', () => {
    const collector = new OutputCollector();
    collector.append('a');
    const outputs = collector.outputs();
    collector.append('b');
    expect(outputs).toEqual(['a']);
    expect(Object.isFrozen(outputs)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses cap %s', (cap) => {
    expect(() => new OutputCollector(cap)).toThrow(RangeError);
  });
});
