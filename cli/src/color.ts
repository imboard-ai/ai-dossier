/**
 * Terminal color helper shared by CLI commands.
 *
 * Colors are emitted only on a TTY and never when NO_COLOR is set
 * (https://no-color.org); FORCE_COLOR=1 turns them on for piped output.
 * Evaluated per call so tests and wrappers can flip the environment.
 */

const CODES = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const;

export type ColorName = keyof typeof CODES;

export function colorEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0') return true;
  return Boolean(stream.isTTY);
}

/** Wrap text in an ANSI color, or return it untouched when color is off. */
export function paint(color: Exclude<ColorName, 'reset'>, text: string): string {
  return colorEnabled() ? `${CODES[color]}${text}${CODES.reset}` : text;
}

/** Escape-code table whose values collapse to '' when color is off. */
export const colors: Record<ColorName, string> = Object.defineProperties(
  {} as Record<ColorName, string>,
  Object.fromEntries(
    (Object.keys(CODES) as ColorName[]).map((name) => [
      name,
      { enumerable: true, get: () => (colorEnabled() ? CODES[name] : '') },
    ])
  )
);
