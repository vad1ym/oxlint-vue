#!/usr/bin/env node
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { runOxlint } from './run.js'
import { parseJsonc } from './jsonc.js'
import { moduleDir } from './resolve.js'
import type { Diagnostic, OxlintConfig } from './types.js'

/** The colour helpers, each either wrapping in an escape or returning as-is. */
type Colours = Record<'red' | 'yellow' | 'dim' | 'bold' | 'cyan', (s: string) => string>

const C: Colours = process.stdout.isTTY && !process.env.NO_COLOR
  ? {
      red: s => `\x1b[31m${s}\x1b[0m`,
      yellow: s => `\x1b[33m${s}\x1b[0m`,
      dim: s => `\x1b[2m${s}\x1b[0m`,
      bold: s => `\x1b[1m${s}\x1b[0m`,
      cyan: s => `\x1b[36m${s}\x1b[0m`,
    }
  : new Proxy({}, { get: () => ((s: string) => s) }) as Colours

/**
 * Translate a gitignore-ish glob into a RegExp.
 *
 * Only the subset oxlint's `ignorePatterns` actually uses is handled: `**`
 * across separators, `*` within a segment, and `?`. Anything unrecognised is
 * escaped so a stray metacharacter cannot silently widen the match.
 */
function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else {
        re += '[^/]*'
      }
      continue
    }
    if (c === '?') { re += '[^/]'; continue }
    re += c!.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** Build a predicate from an oxlint config's ignorePatterns. */
async function buildIgnore(cwd: string): Promise<(abs: string) => boolean> {
  const { findConfig } = await import('./run.js')
  const configPath = await findConfig(cwd)
  if (!configPath) return () => false

  // Follow `extends` so a preset's ignorePatterns are honoured too.
  const collect = async (
    file: string,
    seen: Set<string> = new Set(),
  ): Promise<string[]> => {
    const resolved = path.resolve(file)
    if (seen.has(resolved)) return []
    seen.add(resolved)
    try {
      const cfg = parseJsonc<OxlintConfig>(await fs.readFile(resolved, 'utf8'))
      const inherited: string[] = []
      for (const parent of cfg.extends ?? []) {
        inherited.push(
          ...await collect(path.resolve(path.dirname(resolved), parent), seen),
        )
      }
      return [...inherited, ...(cfg.ignorePatterns ?? [])]
    } catch {
      return []
    }
  }

  const patterns = await collect(configPath)
  if (!patterns.length) return () => false

  const regexes = patterns.map(globToRegExp)
  // On macOS a temp dir reached via /var resolves to /private/var, so a plain
  // path.relative can yield a "../.." chain that matches nothing. Compare
  // against the real paths, and fall back to the absolute path so a file
  // outside cwd is still testable.
  const realCwd = await fs.realpath(cwd).catch(() => cwd)

  return (abs: string) => {
    const rel = path.relative(realCwd, abs).split(path.sep).join('/')
    const candidates = rel.startsWith('..')
      ? [abs.split(path.sep).join('/')]
      : [rel, `/${rel}`]
    return regexes.some(r => candidates.some(c => r.test(c)))
  }
}

async function collectVueFiles(
  targets: string[],
  cwd: string,
  isIgnored: (abs: string) => boolean = () => false,
): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()

  const visit = async (target: string): Promise<void> => {
    // realpath so that ignore matching (which also uses real paths) lines up
    // on platforms where the cwd is reached through a symlink.
    const abs = await fs.realpath(path.resolve(cwd, target)).catch(
      () => path.resolve(cwd, target),
    )
    if (seen.has(abs)) return
    seen.add(abs)

    let stat
    try {
      stat = await fs.stat(abs)
    } catch {
      return
    }

    if (stat.isFile()) {
      if (abs.endsWith('.vue') && !isIgnored(abs)) out.push(abs)
      return
    }
    if (!stat.isDirectory()) return

    const base = path.basename(abs)
    if (base === 'node_modules' || base === '.git' || base === 'dist') return
    if (isIgnored(abs)) return

    const entries = await fs.readdir(abs)
    await Promise.all(entries.map(e => visit(path.join(abs, e))))
  }

  await Promise.all(targets.map(visit))
  return out.sort()
}

function render(diagnostics: Diagnostic[], cwd: string): void {
  if (!diagnostics.length) return

  const byFile = new Map<string, Diagnostic[]>()
  for (const d of diagnostics) {
    if (!byFile.has(d.filename)) byFile.set(d.filename, [])
    byFile.get(d.filename)!.push(d)
  }

  for (const [file, list] of [...byFile].sort()) {
    list.sort((a, b) => a.line - b.line || a.column - b.column)
    process.stdout.write(`\n${C.bold(C.cyan(path.relative(cwd, file)))}\n`)
    for (const d of list) {
      const sev = d.severity === 'warning' ? C.yellow('warn ') : C.red('error')
      const pos = C.dim(`${d.line}:${d.column}`.padEnd(7))
      process.stdout.write(`  ${pos} ${sev}  ${d.message}  ${C.dim(d.rule)}\n`)
    }
  }
}

const HELP = `oxlint-vue -- Vue SFC linting on the oxlint engine

  oxlint-vue init                    create .oxlintrc.json extending the preset
  oxlint-vue [paths...] [options] [-- <oxlint args>]

Options
  -f, --format=<fmt>     pretty (default), json, github, compact
      --fix              apply oxlint's auto-fixes to <script> blocks
      --format-code      format .vue files with oxfmt (template, script, style)
      --check-format     fail if any file is not formatted, changing nothing
  -w, --watch            re-lint on change until interrupted
      --lsp              start the language server (for editors, not humans)
      --quiet            report errors only, suppress warnings
      --max-warnings=<n> exit non-zero if warnings exceed n
  -V, --version          print version
  -h, --help             print this help

Arguments after -- go to oxlint verbatim, e.g.
  oxlint-vue src -- -D correctness -D suspicious

Exit codes: 0 clean, 1 problems found, 2 tool error.
`

async function readVersion(): Promise<string> {
  const here = moduleDir(import.meta.url)
  const pkg = JSON.parse(
    await fs.readFile(path.join(here, '..', 'package.json'), 'utf8'),
  ) as { version: string }
  return pkg.version
}

/** GitHub Actions workflow commands -- annotations appear inline on the PR. */
function renderGithub(diagnostics: Diagnostic[], cwd: string): void {
  for (const d of diagnostics) {
    const level = d.severity === 'warning' ? 'warning' : 'error'
    const file = path.relative(cwd, d.filename)
    // Newlines and commas would terminate the workflow command early.
    const msg = `${d.message} (${d.rule})`.replace(/\r?\n/g, ' ')
    process.stdout.write(
      `::${level} file=${file},line=${d.line},col=${d.column}::${msg}\n`,
    )
  }
}

/** One diagnostic per line -- easy to grep, diff and pipe. */
function renderCompact(diagnostics: Diagnostic[], cwd: string): void {
  for (const d of diagnostics) {
    const file = path.relative(cwd, d.filename)
    process.stdout.write(
      `${file}:${d.line}:${d.column}: ${d.severity} ${d.message} [${d.rule}]\n`,
    )
  }
}

interface WatchOptions {
  extraArgs: string[]
  format: string
  quiet: boolean
  fix: boolean
}

/**
 * Watch mode: re-lint on change until interrupted.
 *
 * Editors write a file through several syscalls (truncate, write, rename), each
 * firing its own event, so runs are debounced. A run in flight also sets a
 * pending flag rather than queueing, which keeps a burst of saves to one
 * follow-up pass instead of one pass per event.
 */
async function runWatch(
  roots: string[],
  cwd: string,
  opts: WatchOptions,
): Promise<number> {
  const { watch: fsWatch } = await import('node:fs')
  const { format, quiet, extraArgs } = opts
  const isIgnored = await buildIgnore(cwd)

  let running = false
  let pending = false
  let timer: NodeJS.Timeout | null = null

  const pass = async (): Promise<void> => {
    if (running) { pending = true; return }
    running = true
    try {
      const files = await collectVueFiles(roots, cwd, isIgnored)
      let diagnostics = await runOxlint(files, { cwd, extraArgs })
      if (quiet) diagnostics = diagnostics.filter(d => d.severity === 'error')

      if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H')

      if (format === 'compact') renderCompact(diagnostics, cwd)
      else if (format === 'github') renderGithub(diagnostics, cwd)
      else if (format === 'json') {
        process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`)
      } else render(diagnostics, cwd)

      const errors = diagnostics.filter(d => d.severity === 'error').length
      process.stdout.write(
        `\n${C.bold(`${files.length} file(s)`)}, `
        + `${C.red(`${errors} error(s)`)}, `
        + `${C.yellow(`${diagnostics.length - errors} warning(s)`)}  `
        + `${C.dim('watching, ^C to exit')}\n`,
      )
    } catch (err) {
      process.stderr.write(`oxlint-vue: ${(err as Error).message}\n`)
    } finally {
      running = false
      if (pending) { pending = false; schedule() }
    }
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(pass, 50)
  }

  for (const root of roots) {
    try {
      fsWatch(path.resolve(cwd, root), { recursive: true }, (_e, name) => {
        if (name && !name.endsWith('.vue')) return
        schedule()
      })
    } catch (err) {
      process.stderr.write(
        `oxlint-vue: cannot watch ${root}: ${(err as Error).message}\n`,
      )
      return 2
    }
  }

  await pass()
  // Resolve never: the process lives until interrupted.
  return new Promise<number>(() => {})
}

/**
 * Write a starter .oxlintrc.json that extends the shipped preset.
 *
 * `extends` rather than a copy so the preset keeps improving with upgrades;
 * the local file is only for the project's own overrides.
 */
async function runInit(cwd: string): Promise<number> {
  const lintTarget = path.join(cwd, '.oxlintrc.json')
  const fmtTarget = path.join(cwd, '.oxfmtrc.json')
  const created: string[] = []
  const skipped: string[] = []

  const write = async (target: string, config: unknown): Promise<void> => {
    try {
      await fs.access(target)
      skipped.push(path.basename(target))
      return
    } catch { /* does not exist -- good */ }
    await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    created.push(path.basename(target))
  }

  // The presets live in their own package so people looking for an antfu
  // config on oxlint can find them. This tool works without it -- oxlint's
  // default categories still apply -- so the package is detected, never
  // required, and never installed on the user's behalf.
  const presetDir = path.join(cwd, 'node_modules', 'antfu-oxlint-vue', 'configs')
  const hasPresets = existsSync(presetDir)

  const extendsList: string[] = []
  if (hasPresets) {
    extendsList.push('./node_modules/antfu-oxlint-vue/configs/antfu.oxlintrc.json')
  }

  await write(lintTarget, {
    $schema: './node_modules/oxlint/configuration_schema.json',
    ...(extendsList.length ? { extends: extendsList } : {}),
    // oxlint does not inherit ignorePatterns through `extends`, so a preset
    // cannot supply it. Without this the first run walks node_modules.
    ignorePatterns: ['**/node_modules/**', '**/dist/**'],
    rules: {},
    settings: { vue: { rules: {} } },
  })

  // oxfmt has no `extends`, so the formatter preset is copied rather than
  // referenced. It is short and rarely changes; the alternative is silently
  // formatting to oxfmt's defaults, which disagree with the lint preset
  // (double quotes, semicolons) and would make the two fight.
  let fmtPreset: Record<string, unknown> | null = null
  if (hasPresets) {
    try {
      fmtPreset = parseJsonc<Record<string, unknown>>(
        await fs.readFile(path.join(presetDir, 'antfu.oxfmtrc.json'), 'utf8'),
      )
      fmtPreset.$schema = './node_modules/oxfmt/configuration_schema.json'
    } catch { /* preset unreadable -- skip the formatter config */ }
  }
  if (fmtPreset) await write(fmtTarget, fmtPreset)

  for (const name of skipped) {
    process.stderr.write(`oxlint-vue: ${name} already exists, left alone.\n`)
  }
  if (!created.length) {
    process.stderr.write(
      'Add this to .oxlintrc.json "extends" to pick up the preset:\n'
      + '  "./node_modules/antfu-oxlint-vue/configs/antfu.oxlintrc.json"\n',
    )
    return 1
  }

  process.stdout.write(
    `${C.bold(`Created ${created.join(' and ')}`)}\n\n`
    + `  Lint:   ${C.cyan('npx oxlint-vue src')}\n`
    + `  Fix:    ${C.cyan('npx oxlint-vue src --fix --format-code')}\n`
    + `  Watch:  ${C.cyan('npx oxlint-vue src --watch')}\n`
    + `  CI:     ${C.cyan('npx oxlint-vue src --check-format')}\n\n`
    + `Override oxlint rules under ${C.dim('"rules"')}, this tool's template\n`
    + `rules under ${C.dim('"settings.vue.rules"')}, and formatting in\n`
    + `${C.dim('.oxfmtrc.json')}.\n`,
  )

  if (!hasPresets) {
    // Without a preset the config is bare: oxlint's default categories apply,
    // but none of the antfu rules, globals or formatting do. Worth saying so,
    // since the difference is invisible until someone compares outputs.
    process.stdout.write(
      `\n${C.dim('Tip: npm i -D antfu-oxlint-vue adds the antfu preset —')}\n`
      + `${C.dim('     47 lint rules, Vue/Nuxt globals and matching')}\n`
      + `${C.dim('     formatting. Re-run init afterwards to wire it up.')}\n`,
    )
  }
  return 0
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const targets: string[] = []
  const extraArgs: string[] = []
  let format = 'pretty'
  let fix = false
  let formatCode = false
  let checkFormat = false
  let watch = false
  let lsp = false
  let quiet = false
  let maxWarnings = -1

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--format' || a === '-f') { format = argv[++i] ?? ''; continue }
    if (a.startsWith('--format=')) { format = a.slice(9); continue }
    if (a === '--fix') { fix = true; continue }
    if (a === '--format-code') { formatCode = true; continue }
    if (a === '--check-format') { checkFormat = true; continue }
    if (a === '--watch' || a === '-w') { watch = true; continue }
    if (a === '--lsp') { lsp = true; continue }
    if (a === '--quiet') { quiet = true; continue }
    if (a === '--max-warnings') { maxWarnings = Number(argv[++i]); continue }
    if (a.startsWith('--max-warnings=')) {
      maxWarnings = Number(a.slice(15))
      continue
    }
    if (a === '--version' || a === '-V') {
      process.stdout.write(`${await readVersion()}\n`)
      return 0
    }
    if (a === '--help' || a === '-h') {
      process.stdout.write(HELP)
      return 0
    }
    if (a === '--') { extraArgs.push(...argv.slice(i + 1)); break }
    if (a.startsWith('-')) { extraArgs.push(a); continue }
    targets.push(a)
  }

  if (targets[0] === 'init') return runInit(process.cwd())

  if (lsp) {
    const { startProxy } = await import('./lsp.js')
    await startProxy({ cwd: process.cwd() })
    // The server owns the process from here until the editor disconnects.
    return new Promise<number>(() => {})
  }

  const cwd = process.cwd()
  const roots = targets.length ? targets : ['.']

  if (watch) {
    return runWatch(roots, cwd, { extraArgs, format, quiet, fix })
  }

  const files = await collectVueFiles(roots, cwd, await buildIgnore(cwd))

  if (!files.length) {
    process.stderr.write('oxlint-vue: no .vue files found\n')
    return 0
  }

  // Formatting runs before linting so the report describes the code the user
  // is left with, not the code they had a moment ago.
  let formattedCount = 0
  let unformatted: string[] = []
  let reverted: string[] = []
  if (formatCode || checkFormat) {
    const { formatFiles } = await import('./format.js')
    const result = await formatFiles(files, {
      cwd,
      mode: checkFormat ? 'check' : 'write',
    })
    if (checkFormat) unformatted = result.changed
    else formattedCount = result.changed.length
    reverted = result.reverted ?? []
  }

  let fixedCount = 0
  if (fix) {
    const { fixFiles } = await import('./fix.js')
    const { resolveOxlintPath } = await import('./run.js')
    const fixed = await fixFiles(files, {
      cwd,
      oxlintPath: resolveOxlintPath(cwd),
      extraArgs,
    })
    fixedCount = fixed.length
  }

  // Re-lint after fixing so the report reflects what is left, not what was.
  let diagnostics = await runOxlint(files, { cwd, extraArgs })
  if (quiet) diagnostics = diagnostics.filter(d => d.severity === 'error')

  const errors = diagnostics.filter(d => d.severity === 'error').length
  const warnings = diagnostics.length - errors

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`)
  } else if (format === 'github') {
    renderGithub(diagnostics, cwd)
  } else if (format === 'compact') {
    renderCompact(diagnostics, cwd)
  } else {
    render(diagnostics, cwd)
    if (formattedCount) {
      process.stdout.write(
        `\n${C.bold(`formatted ${formattedCount} file(s)`)}\n`,
      )
    }
    if (reverted.length) {
      process.stdout.write(
        `\n${C.yellow(`${reverted.length} file(s) left unformatted:`)} `
        + 'formatting them produced code that no longer parses, so the\n'
        + 'original was restored. This is an oxfmt bug, not yours.\n',
      )
      for (const f of reverted) {
        process.stdout.write(`  ${path.relative(cwd, f)}\n`)
      }
    }
    if (unformatted.length) {
      process.stdout.write(
        `\n${C.yellow(`${unformatted.length} file(s) need formatting:`)}\n`,
      )
      for (const f of unformatted.slice(0, 20)) {
        process.stdout.write(`  ${path.relative(cwd, f)}\n`)
      }
      if (unformatted.length > 20) {
        process.stdout.write(`  ${C.dim(`... and ${unformatted.length - 20} more`)}\n`)
      }
      process.stdout.write(`  ${C.dim('run with --format-code to fix')}\n`)
    }
    if (fixedCount) {
      process.stdout.write(`\n${C.bold(`fixed ${fixedCount} file(s)`)}\n`)
    }
    process.stdout.write(
      `${fixedCount ? '' : '\n'}${C.bold(`${files.length} file(s)`)}, `
      + `${C.red(`${errors} error(s)`)}, ${C.yellow(`${warnings} warning(s)`)}\n`,
    )
  }

  // --check-format is a gate: unformatted files fail the run even when the
  // code itself lints clean.
  if (errors > 0 || unformatted.length > 0) return 1
  if (maxWarnings >= 0 && warnings > maxWarnings) {
    process.stderr.write(
      `oxlint-vue: ${warnings} warnings exceed --max-warnings ${maxWarnings}\n`,
    )
    return 1
  }
  return 0
}

main().then(
  code => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`oxlint-vue: ${(err as Error)?.stack || err}\n`)
    process.exit(2)
  },
)
