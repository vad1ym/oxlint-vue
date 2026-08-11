import { existsSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parse } from '@vue/compiler-sfc'
import { execFileAsync, isMissingBinary, stderrOf, stdoutOf } from './exec.js'
import { resolveBin, spawnableFrom } from './resolve.js'

/**
 * Formatting is delegated to oxfmt, which already understands `.vue` as a whole
 * -- template, script and style. There is nothing for the padding preprocessor
 * to do here: oxfmt reads the real file, so positions and structure are its
 * problem, not ours.
 *
 * Wrapping it rather than shelling out from the README buys three things:
 * one command for the whole pipeline, one config discovery story, and a
 * guaranteed order (format first, then lint) so the report reflects the code
 * the user ends up with.
 */

export type FormatMode = 'write' | 'check'

export interface FormatOptions {
  cwd?: string
  oxfmtPath?: string
  mode?: FormatMode
  extraArgs?: string[]
}

export interface FormatResult {
  /** Files rewritten (write mode) or that would change (check mode). */
  changed: string[]
  /** Files restored because formatting broke them. Always empty in check mode. */
  reverted: string[]
  /** True when nothing needs doing. */
  ok: boolean
}

/**
 * Find the oxfmt binary. Mirrors resolveOxlint: the linted project may not
 * depend on oxfmt itself, so fall back to the copy next to this package and
 * finally to PATH.
 */
export function resolveOxfmtPath(cwd: string): string {
  return resolveBin('oxfmt', cwd, import.meta.url)
}

/**
 * Put back the semicolons oxfmt strips from multi-statement inline handlers.
 *
 * oxfmt reformats `@focus="a = true; b = false"` into
 *
 *     @focus="
 *       a = true
 *       b = false
 *     "
 *
 * Vue parses a directive value as a single expression, so without the
 * separators it is a syntax error. The fix is textual and deliberately narrow:
 * only a directive whose value spans several lines is touched, and only lines
 * that look like a complete statement get a `;`. A continuation line (one that
 * ends mid-expression, or whose successor starts with an operator, `)`, `]`,
 * `}`, `.` or `?`) is left alone, so a legitimately wrapped single expression
 * is never damaged.
 *
 * The caller only keeps the result if it parses, so a bad guess costs nothing.
 */
export function restoreDirectiveSemicolons(source: string): string {
  // Opening of a directive value that oxfmt pushed onto its own line.
  const opener = /(\s)((?:@|:|v-)[^\s=]*)="\n/g
  let out = source
  let match: RegExpExecArray | null

  opener.lastIndex = 0
  const edits: [number, number, string][] = []
  // eslint-disable-next-line no-cond-assign
  while ((match = opener.exec(source)) !== null) {
    const valueStart = match.index + match[0].length
    const close = source.indexOf('"', valueStart)
    if (close < 0) continue

    const body = source.slice(valueStart, close)
    if (!body.includes('\n')) continue

    const lines = body.split('\n')
    const patched = lines.map((line, i) => {
      const text = line.trimEnd()
      const code = text.trim()
      if (!code) return line
      // Already terminated, or an opening/continuation of a larger expression.
      if (/[;,{[(?:&|+\-*/%=<>!]$/.test(code)) return line
      // Last line: the closing quote follows, nothing to separate from.
      const nextCode = lines.slice(i + 1).find(l => l.trim())
      if (!nextCode) return line
      // The next line continues this expression rather than starting a new one.
      if (/^[)\]}.?:,&|+\-*/%=<>]/.test(nextCode.trim())) return line
      return `${text};`
    })

    const rebuilt = patched.join('\n')
    if (rebuilt !== body) edits.push([valueStart, close, rebuilt])
  }

  // Apply back to front so earlier offsets stay valid.
  for (let i = edits.length - 1; i >= 0; i--) {
    const [start, end, text] = edits[i]!
    out = out.slice(0, start) + text + out.slice(end)
  }
  return out
}

/**
 * True when the file already is what `--format-code` would produce.
 *
 * oxfmt reports such a file as "different" because it still wants to strip the
 * semicolons that keep the directive parseable. Formatting a scratch copy and
 * running the same repair reproduces exactly what --format-code would write;
 * if that equals the file on disk, there is nothing left to do and CI must not
 * fail on it.
 */
async function onlyDiffersBySafetySemicolons(
  file: string,
  oxfmtPath: string,
  configArgs: string[],
  cwd: string,
): Promise<boolean> {
  const current = await readFile(file, 'utf8').catch(() => null)
  if (current == null) return false

  const dir = await mkdtemp(path.join(os.tmpdir(), 'oxxxfmt-probe-'))
  try {
    const scratch = path.join(dir, path.basename(file))
    await writeFile(scratch, current, 'utf8')
    try {
      const probe = spawnableFrom(oxfmtPath)
      await execFileAsync(
        probe.command,
        [...probe.args, '--write', ...configArgs, scratch],
        { cwd },
      )
    } catch { /* exit code is not meaningful here */ }
    const formatted = await readFile(scratch, 'utf8').catch(() => null)
    if (formatted == null) return false
    return restoreDirectiveSemicolons(formatted) === current
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

const FORMAT_CONFIG_NAMES = [
  // JS first, for the same reason as the lint config.
  'oxfmt.config.mjs',
  'oxfmt.config.js',
  'oxfmt.config.ts',
  '.oxfmtrc.json',
  '.oxfmtrc',
  'oxfmt.json',
]

/** Walk up from cwd looking for an oxfmt config. */
export async function findFormatConfig(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd)
  for (;;) {
    for (const name of FORMAT_CONFIG_NAMES) {
      const candidate = path.join(dir, name)
      try {
        await access(candidate)
        return candidate
      } catch { /* keep looking */ }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Run oxfmt over `files`.
 *
 * mode 'write' formats in place and returns the files that changed; mode
 * 'check' reports which files would change without touching them.
 */
export async function formatFiles(
  files: string[],
  opts: FormatOptions = {},
): Promise<FormatResult> {
  const {
    cwd = process.cwd(),
    oxfmtPath = resolveOxfmtPath(cwd),
    mode = 'write',
    extraArgs = [],
  } = opts

  if (!files.length) return { changed: [], reverted: [], ok: true }

  // oxfmt discovers .oxfmtrc.json upward from cwd on its own, so it is only
  // passed explicitly when the caller did not already supply -c.
  const hasConfig = extraArgs.some(
    a => a === '-c' || a === '--config' || a.startsWith('--config='),
  )
  const discovered = hasConfig ? null : await findFormatConfig(cwd)
  const configArgs = discovered ? ['-c', discovered] : []

  // oxfmt rejects --write together with --list-different, so in write mode the
  // "what changed" answer has to come from comparing the files ourselves.
  const before = new Map<string, string | null>()
  if (mode !== 'check') {
    await Promise.all(files.map(async (f) => {
      before.set(f, await readFile(f, 'utf8').catch(() => null))
    }))
  }

  const args = [
    ...(mode === 'check' ? ['--list-different'] : ['--write']),
    ...configArgs,
    ...extraArgs,
    ...files,
  ]

  let stdout = ''
  let stderr = ''
  let failed = false

  try {
    const bin = spawnableFrom(oxfmtPath)
    const res = await execFileAsync(bin.command, [...bin.args, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    })
    stdout = res.stdout
    stderr = res.stderr
  } catch (err) {
    if (isMissingBinary(err)) {
      throw new Error(
        `could not execute oxfmt at "${oxfmtPath}". `
        + 'Install it in the project or alongside oxlint-vue.',
      )
    }
    // Exit 1 means "files differ", which is the answer, not a failure.
    stdout = stdoutOf(err)
    stderr = stderrOf(err)
    failed = true
  }

  if (mode === 'check') {
    // oxfmt prints the differing paths on stderr, not stdout.
    const listed = `${stdout}\n${stderr}`
      .split('\n')
      .map(l => l.trim())
      .filter(l => /\.(?:vue|ts|js|mts|cts|mjs|cjs|tsx|jsx)$/.test(l))
      .map(l => path.resolve(cwd, l))

    // Keep only the files we were asked about: oxfmt walks whole directories,
    // so it also reports .ts/.md files this run has no opinion on.
    const asked = new Set(files.map(f => path.resolve(cwd, f)))
    const scoped = listed.filter(f => asked.has(f))

    // A file whose only remaining difference is the semicolons we deliberately
    // restored is not "unformatted": oxfmt wants to strip them, which would
    // break it, and --format-code puts them straight back. Left in the list it
    // would fail CI forever with no fix available, so it is filtered out --
    // but only after confirming that is genuinely the sole difference.
    const changed: string[] = []
    for (const f of scoped) {
      if (!f.endsWith('.vue')) { changed.push(f); continue }
      if (!await onlyDiffersBySafetySemicolons(f, oxfmtPath, configArgs, cwd)) {
        changed.push(f)
      }
    }

    return { changed, reverted: [], ok: changed.length === 0 }
  }

  // A non-zero exit with nothing rewritten means oxfmt actually failed.
  const changed: string[] = []
  const reverted: string[] = []

  for (const f of files) {
    const prev = before.get(f)
    if (prev == null) continue
    const next = await readFile(f, 'utf8').catch(() => null)
    if (next == null || next === prev) continue

    // Verify the formatted file still parses. oxfmt 0.63.0 applies `semi: false`
    // to multi-statement inline handlers (`@focus="a = true; b = false"`),
    // splitting them across lines without the separators Vue needs. Silently
    // corrupting source is the worst thing a formatter can do.
    if (f.endsWith('.vue')) {
      const wasValid = parse(prev, { filename: f }).errors.length === 0
      const isValid = parse(next, { filename: f }).errors.length === 0

      if (wasValid && !isValid) {
        // Repair the known failure rather than giving up on the file: put the
        // semicolons back into multi-line directive values. Only accepted if
        // the result actually parses, so an unrelated breakage still falls
        // through to the rollback below.
        const repaired = restoreDirectiveSemicolons(next)
        if (repaired !== next
          && parse(repaired, { filename: f }).errors.length === 0) {
          await writeFile(f, repaired, 'utf8')
          changed.push(f)
          continue
        }
        await writeFile(f, prev, 'utf8')
        reverted.push(f)
        continue
      }
    }
    changed.push(f)
  }

  if (failed && changed.length === 0 && reverted.length === 0) {
    const detail = (stderr || stdout || '').trim().split('\n')[0] ?? ''
    throw new Error(`oxfmt failed: ${detail}`)
  }

  return { changed, reverted, ok: true }
}
