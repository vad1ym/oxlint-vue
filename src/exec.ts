import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const execFileAsync = promisify(execFile)

/**
 * What `child_process` rejects with.
 *
 * The JavaScript version reached for `err.stdout` and `err.code` on a value
 * typed `unknown`, which is exactly the kind of access that is right until the
 * shape changes. Both CLIs this tool drives exit non-zero as a normal outcome
 * -- oxlint exits 1 when it reports problems, oxfmt when files differ -- so
 * reading the payload off a rejection is the common path, not the edge case.
 */
export interface ExecError extends Error {
  /** Process exit code, or a spawn failure such as `ENOENT`. */
  code?: number | string
  stdout?: string
  stderr?: string
}

export function isExecError(err: unknown): err is ExecError {
  return err instanceof Error
}

/** The captured stdout of a failed run, or '' when there was none. */
export function stdoutOf(err: unknown): string {
  return isExecError(err) && typeof err.stdout === 'string' ? err.stdout : ''
}

/** The captured stderr of a failed run, or '' when there was none. */
export function stderrOf(err: unknown): string {
  return isExecError(err) && typeof err.stderr === 'string' ? err.stderr : ''
}

/** True when the binary could not be spawned at all. */
export function isMissingBinary(err: unknown): boolean {
  return isExecError(err) && err.code === 'ENOENT'
}
