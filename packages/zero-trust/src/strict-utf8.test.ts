import { describe, expect, it } from 'vitest';
import { parseStrictUtf8Json, strictUtf8 } from './strict-utf8';

describe('strict evidence decoding', () => {
  it('preserves valid Unicode and refuses invalid byte sequences and a JSON BOM', () => {
    expect(parseStrictUtf8Json(Buffer.from('{"note":"é 🌱"}'))).toEqual({ note: 'é 🌱' });
    expect(() => strictUtf8(Buffer.from([0xff]))).toThrow();
    expect(() =>
      parseStrictUtf8Json(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))
    ).toThrow();
    expect(() => parseStrictUtf8Json(Buffer.from('\ufeff{}'))).toThrow();
  });
});
