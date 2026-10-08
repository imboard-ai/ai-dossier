/** Evidence bytes must never acquire replacement characters during decoding. */
export function strictUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function parseStrictUtf8Json(bytes: Uint8Array): unknown {
  return JSON.parse(strictUtf8(bytes));
}
