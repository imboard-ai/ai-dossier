/** Everything a run's guests returned to the controller (#1095): exec stdout and stderr
 * and reports read back, kept so a caller can pass it to `evaluateBoundary` as
 * `guestOutputs` for the canary scan. */

/** Default cap on the bytes one collector keeps (64 MiB). */
export const DEFAULT_OUTPUT_CAP_BYTES = 64 * 1024 * 1024;

/** The collection hit its cap, so a scan of it would not cover everything the guest
 * returned; boundary evidence built from it must fail closed. */
export class OutputTruncatedError extends Error {
  constructor(readonly capBytes: number) {
    super(
      `Guest output is incomplete (capture truncation or ${capBytes}-byte cap); the scan would be partial`
    );
    this.name = 'OutputTruncatedError';
  }
}

export class OutputCollector {
  private readonly chunks: string[] = [];
  private kept = 0;
  private dropped = false;

  constructor(readonly capBytes: number = DEFAULT_OUTPUT_CAP_BYTES) {
    if (!Number.isSafeInteger(capBytes) || capBytes <= 0)
      throw new RangeError('OutputCollector cap must be a positive integer');
  }

  /** Appends one guest-returned chunk. Past the cap the rest is dropped and the
   * collection is marked truncated: a partial scan is not a clean scan. */
  append(output: string | Buffer | null | undefined): void {
    if (output === null || output === undefined || output.length === 0) return;
    const bytes = typeof output === 'string' ? Buffer.from(output, 'utf8') : output;
    const room = this.capBytes - this.kept;
    if (bytes.length > room) this.dropped = true;
    if (room <= 0) return;
    // A cut can split a UTF-8 character (decoded as U+FFFD); the collection is
    // marked truncated then anyway.
    const taken = bytes.length > room ? bytes.subarray(0, room) : bytes;
    this.kept += taken.length;
    this.chunks.push(taken.toString('utf8'));
  }

  /** The chunks in arrival order, for `evaluateBoundary`'s `guestOutputs`. Throws
   * `OutputTruncatedError` once anything was dropped: a partial scan is not a clean one. */
  outputs(): readonly string[] {
    if (this.dropped) throw new OutputTruncatedError(this.capBytes);
    return Object.freeze([...this.chunks]);
  }

  get bytes(): number {
    return this.kept;
  }

  /** Broker/report capture already dropped bytes, even if this collector has room. */
  markIncomplete(): void {
    this.dropped = true;
  }

  /** True once anything was dropped at the cap; `outputs()` then refuses. */
  get truncated(): boolean {
    return this.dropped;
  }
}
