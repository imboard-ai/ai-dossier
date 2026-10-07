/** Everything a run's guests returned to the controller (#1095): exec stdout and stderr
 * and files read back, kept so the run's boundary evidence can scan it for canaries. */

/** Default cap on the bytes one collector keeps (64 MiB). */
export const DEFAULT_OUTPUT_CAP_BYTES = 64 * 1024 * 1024;

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
    const taken = bytes.length > room ? bytes.subarray(0, room) : bytes;
    this.kept += taken.length;
    this.chunks.push(taken.toString('utf8'));
  }

  /** The kept chunks, in arrival order (for `evaluateBoundary`'s `guestOutputs`). */
  outputs(): readonly string[] {
    return Object.freeze([...this.chunks]);
  }

  get bytes(): number {
    return this.kept;
  }

  /** True once anything was dropped at the cap; callers must treat the collection
   * as incomplete evidence. */
  get truncated(): boolean {
    return this.dropped;
  }
}
