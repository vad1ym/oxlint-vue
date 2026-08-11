import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * Locate a bundled CLI, the same way for oxlint and oxfmt.
 *
 * `node_modules/.bin/<name>` is deliberately NOT used. npm puts a shell script
 * there on POSIX and a `.CMD` shim on Windows, where the extensionless name
 * does not exist at all -- so spawning it fails with ENOENT, and spawning the
 * `.CMD` requires a shell, which means quoting user-supplied paths correctly on
 * a platform notorious for getting that wrong.
 *
 * The package's own `bin` entry is a plain JS module on every platform, so
 * running it through `process.execPath` (the Node already executing) sidesteps
 * shims, shells and PATH entirely.
 */

/** How to invoke a resolved tool: the executable plus its leading arguments. */
export interface ResolvedBin {
  command: string
  args: string[]
}

/** Directory of the calling module, correct on Windows too. */
export function moduleDir(moduleUrl: string): string {
  // `new URL(url).pathname` yields '/D:/repo/dist/run.js' on Windows -- a
  // leading slash before the drive letter, which is not a usable path.
  return path.dirname(fileURLToPath(moduleUrl))
}

/**
 * Find the JS entry point a package declares in `bin`.
 *
 * The linted project often does not depend on the binary itself (this tool may
 * be installed globally or run through npx), which is why the search does not
 * stop at the first location.
 */
function findBinScript(
  pkg: string,
  binName: string,
  cwd: string,
  moduleUrl: string,
): string | null {
  const roots = [
    path.join(cwd, 'node_modules'),
    path.join(moduleDir(moduleUrl), '..', 'node_modules'),
  ]
  for (const root of roots) {
    const candidate = path.join(root, pkg, 'bin', binName)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Resolve how to run `name`, preferring its JS entry point over the shim.
 *
 * Falls back to the bare name so the OS can find it on PATH; spawn reports
 * ENOENT if it is genuinely absent.
 */
export function resolveBinCommand(
  name: string,
  cwd: string,
  moduleUrl: string,
): ResolvedBin {
  const script = findBinScript(name, name, cwd, moduleUrl)
  if (script) return { command: process.execPath, args: [script] }
  return { command: name, args: [] }
}

/**
 * The single-string form, for callers that only need a path to report or to
 * hand to something that resolves PATH itself.
 */
export function resolveBin(name: string, cwd: string, moduleUrl: string): string {
  return findBinScript(name, name, cwd, moduleUrl) ?? name
}

/**
 * Turn a resolved path into something spawnable.
 *
 * The public API passes tool locations around as plain strings, and a caller
 * may hand us either a package's JS entry point or a real executable. A `.js`
 * file has to run through Node -- on Windows it is not executable at all, and
 * even on POSIX it only works if the shebang survived.
 */
export function spawnableFrom(binPath: string): ResolvedBin {
  if (binPath.endsWith('.js') || binPath.endsWith('.mjs')) {
    return { command: process.execPath, args: [binPath] }
  }
  // A package `bin` entry is a JS module regardless of its extension, so the
  // reliable test is where it lives rather than what it is called.
  if (binPath.includes(`${path.sep}node_modules${path.sep}`)
    && binPath.includes(`${path.sep}bin${path.sep}`)) {
    return { command: process.execPath, args: [binPath] }
  }
  return { command: binPath, args: [] }
}
