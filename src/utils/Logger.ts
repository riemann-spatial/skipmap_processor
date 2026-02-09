/**
 * Centralized logging utility with timestamps.
 * Use this instead of console.log/warn/error directly.
 */

function timestamp(): string {
  return new Date().toISOString();
}

export const Logger = {
  log(message: string, ...args: unknown[]): void {
    console.log(`[${timestamp()}] ${message}`, ...args);
  },

  warn(message: string, ...args: unknown[]): void {
    console.warn(`[${timestamp()}] ${message}`, ...args);
  },

  error(message: string, ...args: unknown[]): void {
    console.error(`[${timestamp()}] ${message}`, ...args);
  },
};
