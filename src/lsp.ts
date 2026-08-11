#!/usr/bin/env node
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { RulesMap } from './types.js'
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseJsonc } from './jsonc.js'
import { preprocess } from './preprocess.js'
import { spawnableFrom } from './resolve.js'
import { findConfig, resolveOxlintPath, VIRTUAL_SUPPRESSED } from './run.js'
import { checkTemplate } from './structural.js'
import type { OxlintConfig } from './types.js'

/**
 * LSP proxy: `oxlint --lsp` with .vue support bolted on.
 *
 * oxlint's own language server answers for .vue files, but always with an empty
 * diagnostics array -- the same template blindness the CLI has. This proxy sits
 * between the editor and that server:
 *
 *   editor <-> oxlint-vue --lsp <-> oxlint --lsp
 *
 *   - .ts/.js and everything else: forwarded untouched.
 *   - .vue: the padded virtual file is sent down instead of the real source, so
 *     the child lints template expressions like ordinary JS. Because padding
 *     preserves every offset, the diagnostics that come back need no
 *     translation -- only the uri is swapped back.
 *   - structural rules run here and are merged into the same publish.
 *
 * Nothing else about the protocol is interpreted: requests and responses pass
 * through verbatim, so features added to the child server keep working.
 */

/**
 * Only the slice of LSP this proxy reads. Everything else rides along in the
 * index signature and is forwarded untouched, which is what keeps the proxy
 * transparent as the child server grows features.
 */
interface LspMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: LspParams
  result?: unknown
  error?: unknown
}

interface LspParams {
  uri?: string
  textDocument?: { uri?: string, text?: string, version?: number }
  contentChanges?: { range?: unknown, text?: string }[]
  diagnostics?: LspDiagnostic[]
  [key: string]: unknown
}

interface LspPosition { line: number, character: number }

interface LspDiagnostic {
  range: { start: LspPosition, end: LspPosition }
  severity?: number
  code?: string | number
  source?: string
  message: string
}

export interface ProxyOptions {
  input?: Readable
  output?: Writable
  cwd?: string
  oxlintPath?: string
}

export interface Proxy {
  child: ChildProcessByStdio<Writable, Readable, null>
  shutdown: () => void
}

const isVue = (uri: unknown): uri is string =>
  typeof uri === 'string' && uri.endsWith('.vue')

/**
 * The child server decides what to lint from the URI's extension: a `.vue` uri
 * gets an empty diagnostics array no matter what text is sent with it. So the
 * document is presented under a `.vue.ts` uri instead, and the swap is undone
 * on the way back. Suffixing (rather than replacing) keeps the `.vue` visible,
 * which is what makes oxlint's own SFC-aware `vue/*` rules still apply.
 */
const VIRTUAL_SUFFIX = '.ts'
const toVirtualUri = (uri: string): string => `${uri}${VIRTUAL_SUFFIX}`
const fromVirtualUri = (uri: string): string => (
  uri.endsWith(`.vue${VIRTUAL_SUFFIX}`)
    ? uri.slice(0, -VIRTUAL_SUFFIX.length)
    : uri
)

/** Reads LSP frames (`Content-Length` header + JSON body) off a stream. */
function createFrameReader(
  onMessage: (msg: LspMessage) => void,
): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0)
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n')
      if (sep < 0) return
      const header = buf.subarray(0, sep).toString('ascii')
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) { buf = buf.subarray(sep + 4); continue }
      const len = Number(match[1])
      const start = sep + 4
      if (buf.length < start + len) return
      const body = buf.subarray(start, start + len).toString('utf8')
      buf = buf.subarray(start + len)
      try {
        onMessage(JSON.parse(body) as LspMessage)
      } catch { /* a frame we cannot parse is not ours to fix */ }
    }
  }
}

function writeFrame(stream: Writable, message: unknown): void {
  const body = JSON.stringify(message)
  stream.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

/**
 * Rewrite every `.vue.ts` uri back to `.vue`, anywhere in a message.
 *
 * Code actions return workspace edits keyed by uri, and `documentChanges`
 * nests them deeper still. Walking the whole structure is simpler -- and less
 * brittle as the child server grows features -- than enumerating each shape.
 */
function restoreUris<T>(value: T): T {
  if (typeof value === 'string') {
    return (
      value.endsWith(`.vue${VIRTUAL_SUFFIX}`) ? fromVirtualUri(value) : value
    ) as T
  }
  if (Array.isArray(value)) return value.map(restoreUris) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      // Object keys are uris too in `WorkspaceEdit.changes`.
      out[restoreUris(k)] = restoreUris(v)
    }
    return out as T
  }
  return value
}

const SUPPRESSED = new Set(VIRTUAL_SUPPRESSED)

/**
 * True for a diagnostic that only exists because of the padding transform.
 * The server reports codes as `eslint(no-unused-expressions)`, so the plugin
 * wrapper is unwrapped before matching, and the bare name is checked too.
 */
function isArtefact(diagnostic: LspDiagnostic): boolean {
  const code = String(diagnostic?.code ?? '')
  const inner = code.replace(/^[^(]*\(/, '').replace(/\)$/, '')
  if (SUPPRESSED.has(inner) || SUPPRESSED.has(code)) return true
  // `eslint(no-unused-vars)` -> plugin-qualified entries like `import/first`.
  const plugin = /^([\w-]+)\(([^)]+)\)$/.exec(code)
  return plugin ? SUPPRESSED.has(`${plugin[1]}/${plugin[2]}`) : false
}

/** Severity numbers as the protocol defines them. */
const ERROR = 1
const WARNING = 2

export async function startProxy(opts: ProxyOptions = {}): Promise<Proxy> {
  const {
    input = process.stdin,
    output = process.stdout,
    cwd = process.cwd(),
    oxlintPath = resolveOxlintPath(cwd),
  } = opts

  const lsp = spawnableFrom(oxlintPath)
  const child = spawn(lsp.command, [...lsp.args, '--lsp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  child.on('error', (err) => {
    process.stderr.write(`oxlint-vue lsp: cannot start oxlint: ${err.message}\n`)
    process.exit(2)
  })

  /** uri -> structural diagnostics for the version we last preprocessed. */
  const structuralByUri = new Map<string, LspDiagnostic[]>()
  /** Virtual files written next to real sources; removed on close and exit. */
  const virtualFiles = new Set<string>()

  const dropVirtual = (file: string): void => {
    try { rmSync(file, { force: true }) } catch { /* already gone */ }
    virtualFiles.delete(file)
  }
  const dropAllVirtual = (): void => {
    for (const f of [...virtualFiles]) dropVirtual(f)
  }

  // Structural rules are ours, so the child never sees them; read the same
  // config it reads so `"vue/no-v-html": "off"` still applies in the editor.
  let structuralConfig: RulesMap = {}
  try {
    const configPath = await findConfig(cwd)
    if (configPath) {
      const cfg = parseJsonc<OxlintConfig>(await readFile(configPath, 'utf8'))
      structuralConfig = { ...cfg.rules, ...cfg.settings?.vue?.rules }
    }
  } catch { /* no config is fine */ }

  /**
   * Replace a .vue document's text with its padded virtual form, and stash the
   * structural diagnostics for the same content.
   */
  const transform = (uri: string, text: string): string => {
    let filename = uri
    try {
      filename = fileURLToPath(uri)
    } catch { /* keep the uri as a label */ }

    let result
    try {
      result = preprocess(text, filename)
    } catch {
      structuralByUri.set(uri, [])
      return text
    }

    const structural: LspDiagnostic[] = []
    if (result.descriptor.template?.ast) {
      for (const d of checkTemplate(
        result.descriptor.template.ast,
        filename,
        text,
        structuralConfig,
        (result.descriptor.scriptSetup ?? result.descriptor.script)?.content,
      )) {
        // Our positions are 1-based; LSP ranges are 0-based.
        const line = Math.max(0, d.line - 1)
        const char = Math.max(0, d.column - 1)
        structural.push({
          range: {
            start: { line, character: char },
            end: { line, character: char + 1 },
          },
          severity: d.severity === 'warning' ? WARNING : ERROR,
          code: d.rule,
          source: 'oxlint-vue',
          message: d.help ? `${d.message}\nhelp: ${d.help}` : d.message,
        })
      }
    }
    structuralByUri.set(uri, structural)

    // The child server reads the file from disk rather than linting the text it
    // was handed, so the virtual document has to actually exist. It is written
    // beside the real one (same directory) so config discovery, tsconfig paths
    // and ignore patterns all resolve exactly as they would for the .vue.
    try {
      writeFileSync(`${filename}${VIRTUAL_SUFFIX}`, result.code, 'utf8')
      virtualFiles.add(`${filename}${VIRTUAL_SUFFIX}`)
    } catch { /* read-only tree: diagnostics degrade, editing still works */ }

    return result.code
  }

  // editor -> child
  const fromEditor = createFrameReader((msg) => {
    const doc = msg.params?.textDocument
    const uri = doc?.uri

    if (doc && isVue(uri)) {
      if (msg.method === 'textDocument/didOpen' && typeof doc.text === 'string') {
        doc.text = transform(uri, doc.text)
      } else if (msg.method === 'textDocument/didChange') {
        // The child advertises full-document sync, so each change carries the
        // whole text; incremental edits would need the virtual file rebuilt
        // from a mirror instead.
        const changes = msg.params?.contentChanges ?? []
        for (const change of changes) {
          if (change.range === undefined && typeof change.text === 'string') {
            change.text = transform(uri, change.text)
          }
        }
      } else if (msg.method === 'textDocument/didClose') {
        structuralByUri.delete(uri)
        try {
          dropVirtual(`${fileURLToPath(uri)}${VIRTUAL_SUFFIX}`)
        } catch { /* uri was not a path */ }
      }
      // Rename after transforming, so `transform` still sees the real path.
      doc.uri = toVirtualUri(uri)
    }

    // Requests that carry a uri elsewhere (code actions, formatting) need the
    // same rename, or the child will not recognise the document it was sent.
    const paramUri = msg.params?.textDocument?.uri
    if (!paramUri && msg.params && isVue(msg.params.uri)) {
      msg.params.uri = toVirtualUri(msg.params.uri)
    }

    writeFrame(child.stdin, msg)
  })

  // child -> editor
  const fromChild = createFrameReader((msg) => {
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
      const virtual = msg.params.uri
      const real = typeof virtual === 'string' ? fromVirtualUri(virtual) : virtual
      if (real !== virtual && typeof real === 'string') {
        // Offsets match the .vue byte for byte, so the child's ranges are
        // already correct -- only our own findings need adding. The uri itself
        // is rewritten by restoreUris on the way out.
        //
        // The CLI suppresses padding artefacts by passing -A to oxlint; the
        // language server takes no such flags, so the same list is applied
        // here as a filter. Without it every template expression shows up as
        // `no-unused-expressions` in the editor.
        msg.params.diagnostics = [
          ...(msg.params.diagnostics ?? []).filter(d => !isArtefact(d)),
          ...(structuralByUri.get(real) ?? []),
        ]
      }
    }
    writeFrame(output, restoreUris(msg))
  })

  input.on('data', fromEditor)
  child.stdout.on('data', fromChild)

  const shutdown = (): void => {
    dropAllVirtual()
    try { child.kill() } catch { /* already gone */ }
  }
  input.on('end', shutdown)
  // Leaving stray .vue.ts files in someone's source tree would be worse than
  // any diagnostic we could offer, so clean up on every exit path.
  process.once('exit', dropAllVirtual)
  process.once('SIGINT', () => { shutdown(); process.exit(0) })
  process.once('SIGTERM', () => { shutdown(); process.exit(0) })
  child.on('exit', (code) => { dropAllVirtual(); process.exit(code ?? 0) })

  return { child, shutdown }
}

// Started directly (editors spawn this file as the server binary).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startProxy().catch((err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`oxlint-vue lsp: ${detail}\n`)
    process.exit(2)
  })
}
