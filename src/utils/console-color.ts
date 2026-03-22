/**
 * Lightweight console color utility.
 *
 * - Uses ANSI escape codes directly (no external dependency).
 * - Respects TTY detection, NO_COLOR=1, BLACKDOGBOT_COLOR=0/1.
 * - File output stays unchanged (callers use these only for console output).
 */

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function isColorEnabled(): boolean {
  // BLACKDOGBOT_COLOR=0 forces off, =1 forces on
  const colorFlag: string | undefined = process.env.BLACKDOGBOT_COLOR ?? process.env.BETTERCLAW_COLOR;

  if (colorFlag === "0") return false;
  if (colorFlag === "1") return true;

  // NO_COLOR=1 forces off (https://no-color.org)
  if (process.env.NO_COLOR) return false;

  // Default: enabled only when stdout is a TTY
  return Boolean(process.stdout.isTTY);
}

const _enabled: boolean = isColorEnabled();

function wrap(code: string): (text: string) => string {
  return (text: string): string => _enabled ? `${ESC}${code}m${text}${RESET}` : text;
}

export const ConsoleColor = {
  dim: wrap("2"),
  gray: wrap("90"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  white: wrap("37"),
  brightRed: wrap("91"),
  brightGreen: wrap("92"),
  brightYellow: wrap("93"),
  brightBlue: wrap("94"),
  brightMagenta: wrap("95"),
  brightCyan: wrap("96"),
  brightWhite: wrap("97"),
  reset: RESET,
  /** Whether color output is enabled */
  enabled: _enabled,
};
