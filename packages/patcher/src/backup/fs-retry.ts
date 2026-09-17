/**
 * Retrying filesystem operations that fail for transient reasons.
 *
 * On Windows a rename over an existing file fails with `EPERM` or `EBUSY`
 * whenever anything else has the target open — most often a virus scanner
 * examining the multi-megabyte file that was just written, but a running
 * Cursor or a backup agent does it too. The operation succeeds moments later.
 *
 * Without a retry the installer reports a rollback for what is really a
 * timing artefact, which looks like a broken tool. The retries are bounded and
 * the error is re-thrown if they run out, so a genuine permission problem is
 * still reported rather than hidden.
 */

/** Error codes that mean "something else is holding the file right now". */
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

const DEFAULT_ATTEMPTS = 6;
const BASE_DELAY_MS = 40;

function isTransient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

/**
 * Blocks the calling thread.
 *
 * The filesystem helpers this wraps are synchronous and are called from a
 * synchronous install pipeline, so there is no event loop turn available to
 * await. `Atomics.wait` is the only way to sleep without one; the total delay
 * is bounded by the attempt count and stays well under a second.
 */
function sleepSync(milliseconds: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

/** Runs `operation`, retrying while it fails for a transient reason. */
export function withRetry<T>(
  operation: () => T,
  options: { attempts?: number; onRetry?: (attempt: number, error: Error) => void } = {},
): T {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === attempts) break;
      options.onRetry?.(attempt, error as Error);
      sleepSync(BASE_DELAY_MS * attempt);
    }
  }

  throw lastError;
}
