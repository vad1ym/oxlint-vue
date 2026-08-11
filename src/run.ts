import type {
  Diagnostic,
  OxlintConfig,
  OxlintJsonDiagnostic,
  OxlintJsonOutput,
  OxlintSpan,
  RulesMap,
} from './types.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  execFileAsync,
  isExecError,
  isMissingBinary,
  stderrOf,
  stdoutOf,
} from './exec.js'
import { parseJsonc } from './jsonc.js'
import { resolveBin, spawnableFrom } from './resolve.js'
import { preprocess } from './preprocess.js'
import { checkTemplate } from './structural.js'

/** Options accepted by {@link runOxlint}. */
export interface RunOptions {
  cwd?: string
  oxlintPath?: string
  extraArgs?: string[]
}

/**
 * Rules that are meaningless against the padded virtual file and would only
 * produce noise. These are artefacts of the transform, not of the user's code.
 */
export const VIRTUAL_SUPPRESSED = [
  // Every template expression is by construction an "unused" expression
  // statement -- that is how it is embedded, not a defect in the SFC.
  'no-unused-expressions',
  // Padding leaves large blank runs; layout/stylistic rules read them wrong.
  'no-irregular-whitespace',
  'unicode-bom',
  'eol-last',
  'max-len',
  'no-multiple-empty-lines',
  // Filename of the virtual file is synthetic.
  'unicorn/filename-case',
  // The virtual file has no imports/exports of its own beyond the SFC script.
  'unicorn/no-empty-file',
  // Template expressions are emitted at the top of the virtual file, above the
  // <script> block, so an import can never be "first". Structurally guaranteed
  // to misfire, not a property of the user's code.
  'import/first',
  // Imports of other SFCs resolve to *virtual* files, which carry only the
  // padded <script> body -- the `export default` that Vue's compiler would
  // synthesise for an SFC does not exist there. Any rule that inspects the
  // shape of an imported module therefore reads a file the user never wrote.
  'import/default',
  'import/named',
  'import/namespace',
  'import/no-named-as-default',
  'import/no-named-as-default-member',
  'import/no-unassigned-import',
  'import/no-unresolved',
  'import/export',
  // Same cause: the template statements sit between/above declarations.
  'import/no-import-module-exports',
  'unicorn/prefer-top-level-await',
  // Emitted constructs land on their attribute's own line, so a following
  // template expression can look like a continuation of the previous line
  // (`(items || []).map(x=>{` then an interpolation beneath it). The layout is
  // ours, not the author's.
  'no-unexpected-multiline',
  // Refs auto-unwrap in templates, so `@click="isOpen = true"` is correct Vue
  // even though `isOpen` is a `const ref()`. As plain JS it reads as assigning
  // to a const, which the padded file cannot distinguish. Suppressed rather
  // than reported: the template form is idiomatic and extremely common.
  'no-const-assign',
]

/**
 * Build a virtual tree mirroring the project layout, run oxlint over it, then
 * rebind diagnostics to the original .vue paths.
 *
 * Because of the padding invariant, "rebinding" is only a path swap -- the
 * line/column numbers are already correct for the .vue file.
 */
export async function runOxlint(
  files: string[],
  opts: RunOptions = {},
): Promise<Diagnostic[]> {
  const {
    cwd = process.cwd(),
    oxlintPath = resolveOxlint(cwd),
    extraArgs = [],
  } = opts

  // The virtual tree lives in a temp dir, so oxlint's own upward config
  // discovery would miss the project's .oxlintrc.json. Resolve it here and
  // pass it explicitly, unless the caller already supplied -c/--config.
  const hasExplicitConfig = extraArgs.some(
    a => a === '-c' || a === '--config' || a.startsWith('--config='),
  )
  const discovered = hasExplicitConfig ? null : await findConfig(cwd)
  const configArgs = discovered ? ['-c', discovered] : []

  // Structural rules are ours, so oxlint never sees them -- read the same
  // config here to honour `"vue/no-v-html": "off"` and friends.
  const explicitConfig = hasExplicitConfig
    ? extraArgs[extraArgs.findIndex(a => a === '-c' || a === '--config') + 1]
      ?? extraArgs.find(a => a.startsWith('--config='))?.slice(9)
    : null
  const structuralConfig = await readRules(explicitConfig ?? discovered)

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oxlint-vue-'))
  /** virtual absolute path -> original absolute path */
  const backMap = new Map<string, string>()
  const structural: Diagnostic[] = []

  try {
    await Promise.all(files.map(async (file) => {
      const abs = path.resolve(cwd, file)
      const source = await fs.readFile(abs, 'utf8')

      // Only .vue needs the padding transform. Anything else is already the
      // JS/TS oxlint expects, so it is mirrored verbatim -- running it through
      // preprocess would blank the whole file.
      if (!abs.endsWith('.vue')) {
        const virt = path.join(tmpRoot, virtualPathFor(abs, cwd))
        await fs.mkdir(path.dirname(virt), { recursive: true })
        await fs.writeFile(virt, source, 'utf8')
        backMap.set(await realish(virt), abs)
        return
      }

      let result
      try {
        result = preprocess(source, abs)
      } catch (err) {
        structural.push({
          filename: abs,
          line: 1,
          column: 1,
          severity: 'error',
          rule: 'oxlint-vue/preprocess',
          message: err instanceof Error ? err.message : String(err),
        })
        return
      }

      // Structural checks run on the template AST, which padding discards.
      if (result.descriptor.template?.ast) {
        structural.push(
          ...checkTemplate(
            result.descriptor.template.ast,
            abs,
            source,
            structuralConfig,
            (result.descriptor.scriptSetup ?? result.descriptor.script)?.content,
          ),
        )
      }

      // Mirror the project structure so relative config/tsconfig resolution and
      // ignore patterns keep behaving the way the user expects.
      //
      // A file outside cwd yields a `../..` relative path, which would escape
      // tmpRoot (and, on macOS, try to mkdir /var). Anchor such files under a
      // dedicated prefix so every virtual file provably stays inside tmpRoot.
      const virt = path.join(tmpRoot, `${virtualPathFor(abs, cwd)}.ts`)
      await fs.mkdir(path.dirname(virt), { recursive: true })
      await fs.writeFile(virt, result.code, 'utf8')
      backMap.set(await realish(virt), abs)
    }))

    const virtualArgs = [...configArgs, ...extraArgs]
    const [virtual, native] = await Promise.all([
      backMap.size
        ? invokeOxlint(oxlintPath, tmpRoot, virtualArgs, backMap, cwd)
        : [],
      // Second pass: oxlint natively on the real .vue files. It reads <script>
      // and knows the block is `<script setup>`, so SFC-aware rules that the
      // virtual .ts cannot express (vue/no-export-in-script-setup and friends)
      // fire here. Positions are already correct, so no rebinding is needed.
      runNativePass(oxlintPath, files, cwd, virtualArgs),
    ])

    return dedupe([...virtual, ...native, ...structural])
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

/**
 * Where a source file lands inside the mirrored temp tree.
 *
 * A file outside cwd yields a `../..` relative path, which would escape
 * tmpRoot (and, on macOS, try to mkdir /var). Anchor such files under a
 * dedicated prefix so every virtual file provably stays inside tmpRoot.
 */
function virtualPathFor(abs: string, cwd: string): string {
  const rel = path.relative(cwd, abs)
  return rel.startsWith('..') || path.isAbsolute(rel)
    ? path.join('_external', abs.replace(/^([A-Z]:)?[\\/]/i, ''))
    : rel
}

const CONFIG_NAMES = [
  // JS first: `init` writes these when the preset package is present, and a
  // project that has both means the .mjs to win.
  'oxlint.config.mjs',
  'oxlint.config.js',
  'oxlint.config.ts',
  '.oxlintrc.json',
  'oxlint.json',
  '.oxlintrc',
]

/** Walk up from cwd looking for an oxlint config to forward explicitly. */
/**
 * Read the `rules` map out of an oxlint config so structural rules can honour
 * it. oxlint's config allows comments and trailing commas, so a strict
 * JSON.parse would reject valid files -- strip both before parsing.
 */
/**
 * Read a config, whichever form it takes.
 *
 * A JS config is imported rather than parsed: it may compute its values, and
 * spreading a preset -- the shape `init` writes -- only resolves at runtime.
 * `defineConfig` is identity, so the default export is the object itself.
 */
export async function loadConfig(resolved: string): Promise<OxlintConfig> {
  if (/\.(?:m|c)?[jt]s$/.test(resolved)) {
    const mod = await import(pathToFileURL(resolved).href) as {
      default?: OxlintConfig
    }
    return mod.default ?? {}
  }
  return parseJsonc<OxlintConfig>(await fs.readFile(resolved, 'utf8'))
}

async function readRules(
  configPath: string | null | undefined,
  seen = new Set<string>(),
): Promise<RulesMap> {
  if (!configPath) return {}
  const resolved = path.resolve(configPath)
  // A config that extends itself (directly or in a cycle) would recurse for
  // ever; visiting each file at most once also makes the merge deterministic.
  if (seen.has(resolved)) return {}
  seen.add(resolved)

  try {
    const cfg = await loadConfig(resolved)

    // oxlint resolves `extends` itself for its own rules, but it never sees
    // ours -- so a preset's `settings.vue.rules` would be lost unless we
    // walk the chain too. Without this, "vue/no-static-inline-styles": "off"
    // in the shipped preset silently has no effect for anyone using `extends`.
    let inherited: RulesMap = {}
    for (const parent of cfg.extends ?? []) {
      const parentPath = path.resolve(path.dirname(resolved), parent)
      inherited = { ...inherited, ...await readRules(parentPath, seen) }
    }

    // Structural rule names are not oxlint rules, and oxlint validates its
    // `rules` map strictly -- listing them there makes it reject the whole
    // config. `settings` is free-form, so that is where they live.
    // Nearer config wins over what it extends.
    return {
      ...inherited,
      ...cfg.rules,
      ...cfg.settings?.vue?.rules,
    }
  } catch {
    return {}
  }
}

export async function findConfig(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd)
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name)
      try {
        await fs.access(candidate)
        return candidate
      } catch { /* keep looking */ }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function realish(p: string): Promise<string> {
  try { return await fs.realpath(p) } catch { return p }
}

/**
 * Find the oxlint binary.
 *
 * The linted project often does not depend on oxlint itself (oxlint-vue may be
 * installed globally or run via npx), so the target's node_modules is only the
 * first candidate -- we then fall back to the copy shipped alongside this
 * package, and finally to PATH.
 */
export function resolveOxlintPath(cwd: string): string {
  return resolveBin('oxlint', cwd, import.meta.url)
}

const resolveOxlint = resolveOxlintPath

/**
 * Rules that only work when oxlint parses the real SFC, because they depend on
 * knowing the code came from a `<script setup>` block. Restricting the native
 * pass to exactly these avoids re-reporting everything the virtual pass already
 * covers -- and, critically, avoids reintroducing the template-blindness false
 * positives (oxlint natively cannot see template usage).
 */
const NATIVE_ONLY_RULES = [
  'vue/no-export-in-script-setup',
  'vue/no-expose-after-await',
  'vue/no-lifecycle-after-await',
  'vue/no-watch-after-await',
  'vue/no-import-compiler-macros',
  'vue/valid-define-props',
  'vue/valid-define-emits',
  'vue/valid-define-options',
  'vue/define-props-declaration',
  'vue/define-emits-declaration',
  'vue/require-default-export',
]

/** Lint the real .vue files for rules that need a true SFC parse. */
async function runNativePass(
  oxlintPath: string,
  files: string[],
  cwd: string,
  baseArgs: string[],
): Promise<Diagnostic[]> {
  if (!files.length) return []

  // Drop any user -D/-W/-A: this pass must report only NATIVE_ONLY_RULES.
  const configOnly: string[] = []
  for (let i = 0; i < baseArgs.length; i++) {
    const a = baseArgs[i]!
    if (a === '-c' || a === '--config') { configOnly.push(a, baseArgs[++i]!); continue }
    if (a.startsWith('--config=')) configOnly.push(a)
  }

  const args = [
    '--format=json',
    ...configOnly,
    '--vue-plugin',
    '-A',
    'all',
    ...NATIVE_ONLY_RULES.flatMap(r => ['-D', r]),
    ...files,
  ]

  let stdout = ''
  try {
    const bin = spawnableFrom(oxlintPath)
    const res = await execFileAsync(bin.command, [...bin.args, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    })
    stdout = res.stdout
  } catch (err) {
    const captured = stdoutOf(err)
    if (!captured) return []
    stdout = captured
  }

  // Positions already refer to the real file, so map paths only.
  const identity = new Map(files.map(f => [f, f]))
  return parseOxlintJson(stdout, cwd, identity, cwd)
}

/** Drop duplicate diagnostics (same file, position and rule). */
function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>()
  const out: Diagnostic[] = []
  for (const d of diagnostics) {
    const key = `${d.filename}:${d.line}:${d.column}:${d.rule}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(d)
  }
  return out
}

async function invokeOxlint(
  oxlintPath: string,
  tmpRoot: string,
  extraArgs: string[],
  backMap: Map<string, string>,
  cwd: string,
): Promise<Diagnostic[]> {
  const args = [
    '--format=json',
    ...VIRTUAL_SUPPRESSED.flatMap(r => ['-A', r]),
    ...extraArgs,
    '.',
  ]

  let stdout = ''
  try {
    const bin = spawnableFrom(oxlintPath)
    const res = await execFileAsync(bin.command, [...bin.args, ...args], {
      cwd: tmpRoot,
      maxBuffer: 64 * 1024 * 1024,
    })
    stdout = res.stdout
  } catch (err) {
    // oxlint exits 1 when it reports problems, which is success for us. Any
    // other failure (missing binary, bad config, crash) must surface loudly:
    // swallowing it makes the tool report a clean run while linting nothing.
    if (isMissingBinary(err)) {
      throw new Error(
        `could not execute oxlint at "${oxlintPath}". `
        + 'Install it in the project or alongside oxlint-vue.',
        { cause: err },
      )
    }
    const captured = stdoutOf(err)
    if (!captured.trim()) {
      const message = isExecError(err) ? err.message : String(err)
      const detail = (stderrOf(err) || message || '').trim()
      throw new Error(
        `oxlint failed (exit ${isExecError(err) ? err.code : undefined}): ${detail}`,
        { cause: err },
      )
    }
    stdout = captured
  }

  return parseOxlintJson(stdout, tmpRoot, backMap, cwd)
}

/**
 * oxlint's JSON shape has moved between versions, so read defensively and key
 * off whichever location fields are present.
 */
export function parseOxlintJson(
  stdout: string,
  tmpRoot: string,
  backMap: Map<string, string>,
  _cwd: string,
): Diagnostic[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []

  let payload: OxlintJsonOutput | OxlintJsonDiagnostic[]
  try {
    payload = JSON.parse(trimmed) as OxlintJsonOutput | OxlintJsonDiagnostic[]
  } catch {
    return []
  }

  const list = Array.isArray(payload)
    ? payload
    : payload.diagnostics || payload.results || []

  const out: Diagnostic[] = []
  for (const d of list) {
    const rawPath = d.filename || d.fileName || d.path || d.file
    if (!rawPath) continue

    const virtAbs = path.resolve(tmpRoot, rawPath)
    let original = backMap.get(virtAbs)
    if (!original) {
      // Fall back to stripping the .ts we appended.
      const guess = virtAbs.replace(/\.ts$/, '')
      original = backMap.get(guess) || [...backMap.entries()]
        .find(([k]) => k.endsWith(path.basename(virtAbs)))?.[1]
    }
    if (!original) continue

    // Location lives inside labels[].span; the primary label is the anchor.
    const start: OxlintSpan | null = d.labels?.[0]?.span ?? d.span ?? null
    const offset = start?.offset ?? d.offset
    out.push({
      filename: original,
      line: start?.line ?? d.line ?? 1,
      column: start?.column ?? d.column ?? 1,
      // `exactOptionalPropertyTypes` forbids writing `undefined` into an
      // optional field, so absent values omit the key rather than set it.
      ...(offset === undefined ? {} : { offset }),
      severity: d.severity === 'warning' ? 'warning' : 'error',
      rule: d.code || d.ruleId || d.rule || 'oxlint',
      message: d.message || d.help || '',
      ...(d.help === undefined ? {} : { help: d.help }),
    })
  }
  return out
}
