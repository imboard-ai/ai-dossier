export interface FormatOptions {
  /** JSON indentation; applies only to output kept in the legacy layout. */
  indent: number;
  sortKeys: boolean;
  updateChecksum: boolean;
  /**
   * Write the Agent Skills (spec) layout. Spec-shaped input always stays spec-shaped;
   * legacy input is converted unless it carries a signature, which a conversion
   * would orphan (re-sign with `ai-dossier sign` to convert a signed dossier).
   */
  toSpec: boolean;
  /** Registry path or file path the Agent Skills `name` is derived from when absent. */
  nameSource?: string;
}

export interface FormatResult {
  formatted: string;
  changed: boolean;
}

export const defaultFormatOptions: FormatOptions = {
  indent: 2,
  sortKeys: true,
  updateChecksum: true,
  toSpec: true,
};
