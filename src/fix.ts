import type { SFCDescriptor } from '@vue/compiler-sfc'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileAsync, isMissingBinary } from './exec.js'
import { preprocess } from './preprocess.js'
import { spawnableFrom } from './resolve.js'
import { findConfig } from './run.js'

export interface FixOptions {
  cwd?: string
  oxlintPath: string
  extraArgs?: string[]
}

/**
 * Apply oxlint's auto-fixes back to the original .vue files.
 *
 * The virtual file is fixed in place by oxlint, then the result is transplanted
 * back line by line. Line-wise (rather than offset-wise) is deliberate: a fix
 * changes length (`let` -> `const`), so offsets after it shift, but oxlint's
 * fixes never move code across lines. Comparing line-for-line therefore stays
 * correct where offset arithmetic would drift.
 *
 * Only lines that belong to a <script> block are transplanted. A "fix" landing
 * on a template line would be a fix to our padding, not to the user's markup,
 * and must never be written back.
 *
 * @returns the absolute paths of the files that were rewritten.
 */
export async function fixFiles(
  files: string[],
  opts: FixOptions,
): Promise<string[]> {
  const { cwd = process.cwd(), oxlintPath, extraArgs = [] } = opts

  // The virtual file lives in a temp dir, so oxlint's upward config discovery
  // finds nothing and every rule falls back to its default. Without the
  // project's config the fix pass would silently do nothing.
  const hasConfig = extraArgs.some(
    a => a === '-c' || a === '--config' || a.startsWith('--config='),
  )
  const discovered = hasConfig ? null : await findConfig(cwd)
  const configArgs = discovered ? ['-c', discovered] : []

  const results: string[] = []
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oxxxfix-'))

  try {
    for (const file of files) {
      const abs = path.resolve(cwd, file)
      const source = await fs.readFile(abs, 'utf8')

      // Plain JS/TS needs no transform and no transplant: oxlint can fix the
      // file in place, which is also the only way it gets fixes at all.
      if (!abs.endsWith('.vue')) {
        try {
          const bin = spawnableFrom(oxlintPath)
          await execFileAsync(
            bin.command,
            [...bin.args, '--fix', ...configArgs, ...extraArgs, abs],
            { cwd, maxBuffer: 32 * 1024 * 1024 },
          )
        } catch (err) {
          if (isMissingBinary(err)) throw err
        }
        if (await fs.readFile(abs, 'utf8') !== source) results.push(abs)
        continue
      }

      let pre
      try {
        pre = preprocess(source, abs)
      } catch {
        continue
      }
      if (!pre.hasScript) continue

      const virt = path.join(tmpRoot, `${path.basename(abs)}.ts`)
      await fs.writeFile(virt, pre.code, 'utf8')

      try {
        const bin = spawnableFrom(oxlintPath)
        await execFileAsync(
          bin.command,
          [...bin.args, '--fix', ...configArgs, ...extraArgs, virt],
          { cwd: tmpRoot, maxBuffer: 32 * 1024 * 1024 },
        )
      } catch (err) {
        // Exit 1 just means diagnostics remained; the fixes were still applied.
        if (isMissingBinary(err)) throw err
      }

      const fixed = await fs.readFile(virt, 'utf8')
      await fs.rm(virt, { force: true })
      if (fixed === pre.code) continue

      const merged = transplant(source, pre.code, fixed, pre.descriptor)
      if (merged == null || merged === source) continue

      await fs.writeFile(abs, merged, 'utf8')
      results.push(abs)
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }

  return results
}

/** Line ranges (0-based, end-exclusive) covered by the SFC's script blocks. */
function scriptLineRanges(
  source: string,
  descriptor: SFCDescriptor,
): [number, number][] {
  const ranges: [number, number][] = []
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue
    const start = block.loc.start.offset
    const end = block.loc.end.offset
    ranges.push([
      countLines(source, 0, start),
      countLines(source, 0, end),
    ])
  }
  return ranges
}

function countLines(text: string, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i++) if (text[i] === '\n') n++
  return n
}

/**
 * Merge fixed script lines back into the original .vue.
 *
 * Returns null when the shapes disagree (line count changed, or a change landed
 * outside a script block) -- the safe outcome is to skip the file rather than
 * risk writing corrupted source.
 */
function transplant(
  source: string,
  virtual: string,
  fixed: string,
  descriptor: SFCDescriptor,
): string | null {
  const vLines = virtual.split('\n')
  const fLines = fixed.split('\n')
  if (vLines.length !== fLines.length) return null

  const srcLines = source.split('\n')
  if (srcLines.length !== vLines.length) return null

  const ranges = scriptLineRanges(source, descriptor)
  const inScript = (i: number): boolean =>
    ranges.some(([a, b]) => i >= a && i <= b)

  let changed = false
  for (let i = 0; i < vLines.length; i++) {
    if (vLines[i] === fLines[i]) continue
    // A change outside a script block would be a change to our own padding.
    if (!inScript(i)) return null
    // The original .vue and the virtual file agree byte-for-byte inside script
    // blocks, so this must hold; if it does not, the mapping is not what we
    // think it is and writing back is unsafe.
    if (srcLines[i] !== vLines[i]) return null
    srcLines[i] = fLines[i]!
    changed = true
  }

  return changed ? srcLines.join('\n') : source
}
