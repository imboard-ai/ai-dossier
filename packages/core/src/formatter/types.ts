export interface FormatOptions {
  indent: number;
  sortKeys: boolean;
  updateChecksum: boolean;
}

export interface FormatResult {
  formatted: string;
  changed: boolean;
}

export const defaultFormatOptions: FormatOptions = {
  indent: 2,
  sortKeys: true,
  updateChecksum: true,
};
