/**
 * Terminal output.
 *
 * Colour is suppressed when the stream is not a TTY or `NO_COLOR` is set, so
 * piping `mycursor status` into a file or a CI log produces readable text
 * instead of escape codes.
 */

const useColour = process.stdout.isTTY === true && !process.env['NO_COLOR'];

const paint = (code: string) => (text: string): string =>
  useColour ? `\u001B[${code}m${text}\u001B[0m` : text;

export const green = paint('32');
export const red = paint('31');
export const yellow = paint('33');
export const blue = paint('34');
export const dim = paint('2');
export const bold = paint('1');

export const ok = (message: string): void => console.log(`${green('  ok')} ${message}`);
export const info = (message: string): void => console.log(`${blue('    >')} ${message}`);
export const warn = (message: string): void => console.log(`${yellow('  warn')} ${message}`);
export const fail = (message: string): void => console.log(`${red(' fail')} ${message}`);
export const heading = (message: string): void => console.log(`\n${bold(message)}`);
export const detail = (message: string): void => console.log(`       ${dim(message)}`);

export const mark = (value: boolean): string => (value ? green('yes') : red('no'));

/** Renders aligned key/value rows. */
export function rows(entries: [string, string][]): void {
  const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
  for (const [key, value] of entries) {
    console.log(`  ${key.padEnd(width)}  ${value}`);
  }
}
