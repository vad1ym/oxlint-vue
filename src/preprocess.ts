import type {
  AttributeNode,
  DirectiveNode,
  ElementNode,
  RootNode,
  SimpleExpressionNode,
  TemplateChildNode,
} from '@vue/compiler-core'
import type { PreprocessResult } from './types.js'
// NodeTypes is a real enum, so the magic numbers (`node.type === 1`) that the
// JavaScript version carried around become named constants.
import { ElementTypes, NodeTypes } from '@vue/compiler-core'
import { parse } from '@vue/compiler-sfc'

/**
 * Padding-based SFC -> virtual TS transform.
 *
 * Invariant: output.length === input.length, and every line break in the input
 * appears at the same byte offset in the output. Therefore any offset reported
 * by oxlint against the virtual file is directly valid against the original
 * .vue file -- no source maps, no diagnostic translation, no fix remapping.
 *
 * Everything that is not JS/TS we want linted becomes spaces. Template
 * expressions are rewritten *in place* into surrounding syntax that is both
 * valid TS and that creates the scope bindings we need, so oxlint's own scope
 * analyser resolves template identifiers for free.
 */

/** The mutable buffer the transform writes into: one entry per UTF-16 unit. */
type CharBuffer = string[]

interface WrapOptions {
  start: number
  end: number
  slotStart: number
  slotEnd: number
  prefix: string
  suffix: string
}

/** A region of the virtual file that carries a template expression. */
interface EmittedRegion {
  start: number
  end: number
  kind?: string
  bare?: boolean
  statements?: boolean
}

/**
 * Replace a region with spaces, preserving \n and \r so line numbers hold.
 *
 * Astral characters occupy two UTF-16 units; blanking both halves with spaces
 * keeps the unit count identical, so the offset invariant is unaffected.
 */
function blankRegion(chars: CharBuffer, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    const c = chars[i]
    if (c !== '\n' && c !== '\r') chars[i] = ' '
  }
}

const isHighSurrogate = (c: string | undefined): boolean =>
  c !== undefined && c >= '\uD800' && c <= '\uDBFF'

const isLowSurrogate = (c: string | undefined): boolean =>
  c !== undefined && c >= '\uDC00' && c <= '\uDFFF'

/** True if writing over [at, at+len) would strand half of a surrogate pair. */
function splitsSurrogate(chars: CharBuffer, at: number, len: number): boolean {
  return (
    (isHighSurrogate(chars[at - 1]) && isLowSurrogate(chars[at]))
    || (isHighSurrogate(chars[at + len - 1]) && isLowSurrogate(chars[at + len]))
  )
}

/** Write `text` at `at`, asserting it cannot overflow its budget. */
function writeAt(
  chars: CharBuffer,
  at: number,
  text: string,
  budgetEnd: number,
): boolean {
  if (!canWrite(chars, at, text.length, budgetEnd)) return false
  for (let i = 0; i < text.length; i++) chars[at + i] = text[i]!
  return true
}

/** Dry run of writeAt: reports whether the write would be accepted. */
function canWrite(
  chars: CharBuffer,
  at: number,
  len: number,
  budgetEnd: number,
): boolean {
  if (at < 0 || at + len > budgetEnd) return false
  if (splitsSurrogate(chars, at, len)) return false
  // Line terminators are structural: overwriting one shifts every subsequent
  // diagnostic up a line. Multi-line attributes put newlines right where we
  // want to write, so refuse rather than corrupt the mapping.
  for (let i = 0; i < len; i++) {
    const c = chars[at + i]
    if (c === '\n' || c === '\r') return false
  }
  return true
}

/**
 * Place an expression inside a wrapper without changing total length.
 *
 * The expression source stays at its ORIGINAL offsets. We only overwrite the
 * padding immediately around it, which is why diagnostics inside the
 * expression keep pointing at the right place in the .vue file.
 *
 * Layout:  [prefix][ ...original expr... ][suffix]
 * `start`/`end` bound the expression; `slotStart`/`slotEnd` bound the writable
 * padding around it (quotes, braces, attribute name -- all already blanked).
 */
function wrapExpression(chars: CharBuffer, opts: WrapOptions): boolean {
  const { start, end, slotStart, slotEnd, prefix, suffix } = opts
  const prefixAt = start - prefix.length
  if (prefixAt < slotStart) return false
  if (end + suffix.length > slotEnd) return false
  // Both halves must fit, or neither may be written -- a lone `;(` would be a
  // syntax error that disables every rule for the whole file.
  if (!canWrite(chars, prefixAt, prefix.length, start)) return false
  if (!canWrite(chars, end, suffix.length, slotEnd)) return false
  writeAt(chars, prefixAt, prefix, start)
  writeAt(chars, end, suffix, slotEnd)
  return true
}

/**
 * True if `text` contains a `;` at depth zero -- i.e. it is a statement list
 * rather than a single expression. Semicolons inside strings, template
 * literals, or any bracket pair do not count.
 */
function hasTopLevelSemicolon(text: string): boolean {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === '\'' || c === '`') { quote = c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ';' && depth === 0) return true
  }
  return false
}

export function preprocess(
  source: string,
  filename = 'file.vue',
): PreprocessResult {
  const { descriptor, errors } = parse(source, { filename })
  // NOTE: split('') and not Array.from(). compiler-sfc reports offsets in
  // UTF-16 code units, so the buffer must be indexed the same way. Array.from
  // splits by code point, which desynchronises every offset after the first
  // astral character (emoji, rare CJK) and quietly corrupts the mapping.
  const chars: CharBuffer = source.split('')

  const parseErrors = errors.map(e => ({
    message: e.message,
    // CompilerError carries a loc; a plain SyntaxError does not.
    offset: ('loc' in e ? e.loc?.start?.offset : undefined) ?? 0,
  }))

  // 1. Blank the entire file, then restore only what we want linted.
  blankRegion(chars, 0, chars.length)

  // 2. Restore <script> / <script setup> byte-for-byte at original offsets.
  const scripts = [descriptor.script, descriptor.scriptSetup].filter(
    (b): b is NonNullable<typeof b> => b !== null,
  )
  for (const block of scripts) {
    // NOTE: `.offset`, not the loc object. `const { start } = block.loc` yields
    // a Position, and `chars[position]` writes to a garbage key without error --
    // the whole <script> then silently vanishes from the virtual file.
    const start = block.loc.start.offset
    const end = block.loc.end.offset
    for (let i = start; i < end; i++) chars[i] = source[i]!
  }

  // 3. Extract template expressions into the blanked template region.
  if (descriptor.template?.ast) {
    extractTemplate(descriptor.template.ast, source, chars, [])
  }

  const code = chars.join('')

  if (code.length !== source.length) {
    throw new Error(
      `padding invariant violated: ${code.length} !== ${source.length} in ${filename}`,
    )
  }

  return { code, descriptor, parseErrors, hasScript: scripts.length > 0 }
}

/** Built-in directives resolve to no user binding. */
const BUILTIN_DIRECTIVES = new Set([
  'if', 'else', 'else-if', 'for', 'on', 'bind', 'model', 'slot', 'pre',
  'once', 'html', 'text', 'show', 'cloak', 'memo', 'is',
])

/** Tags Vue resolves itself, so they name no user binding. */
const BUILTIN_COMPONENTS
  = /^(?:component|template|slot|transition|transition-group|keep-alive|teleport|suspense)$/i

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * Template expressions are emitted so that scope flows correctly:
 *
 *   v-for="item in items"   ->  items.map(item => { ...body... })
 *   v-slot="{ row }"        ->  (({ row }) => { ...body... })
 *
 * Bindings are thus *formulated* in ordinary JS rather than modelled by hand,
 * so oxlint resolves them with its existing scope analyser.
 */
function extractTemplate(
  root: RootNode,
  source: string,
  chars: CharBuffer,
  out: EmittedRegion[],
): void {
  /** Offsets already claimed by emitted code, so later writes cannot clobber. */
  const written = new Set<number>()

  const claim = (from: number, to: number): void => {
    for (let i = from; i < to; i++) written.add(i)
  }

  walk(root)

  function walk(node: RootNode | TemplateChildNode | undefined): void {
    if (!node) return

    if (node.type === NodeTypes.INTERPOLATION) {
      emitExpression(node.content)
      return
    }

    if (node.type === NodeTypes.ELEMENT) {
      const scopeOpeners: DirectiveNode[] = []
      /** Expressions that sit left of their own v-for; see precedesOwnScope. */
      const deferred: DirectiveNode['exp'][] = []

      for (const prop of node.props) {
        // `ref="emblaRef"` is a static attribute, but it names a binding in
        // `<script setup>`. Vue's own tooling cannot see this either (authors
        // routinely add @ts-expect-error), so treat it as a use.
        if (prop.type === NodeTypes.ATTRIBUTE) {
          if (prop.name === 'ref' && prop.value) emitStaticRef(prop.value)
          continue
        }

        // A custom directive `v-maska` resolves to a `vMaska` binding, exactly
        // like a component tag resolves to its import.
        emitDirectiveReference(prop)

        if (prop.name === 'for' && prop.forParseResult) {
          scopeOpeners.push(prop)
          continue
        }
        if (prop.name === 'slot' && prop.exp) {
          scopeOpeners.push(prop)
          continue
        }
        // Position in the virtual file follows the source offset, not the
        // order these run in. So a directive written to the LEFT of the v-for
        // it belongs to -- `<component :is="node" v-for="(node) in list">` --
        // would emit its use before the binding exists, and `node` would be
        // reported both undefined and unused. Vue scopes it correctly, so the
        // honest move is to leave the expression out rather than emit a lie.
        if (!prop.exp) continue
        if (precedesOwnScope(prop, node)) {
          // Emitted later, inside the scope body where the binding exists.
          deferred.push(prop.exp)
          continue
        }
        emitExpression(prop.exp)
      }

      // After the props, so the reference can only be placed in padding that
      // is still genuinely free -- an expression or a `ref="x"` emitted above
      // must not be overwritten.
      emitComponentReference(node)

      // Children first: they fill the element's interior with expressions, so
      // closeScope() can then find genuinely-free padding for its closer.
      for (const child of node.children) walk(child)
      for (const opener of scopeOpeners) emitScope(opener, node, deferred)
      return
    }

    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        if (typeof child !== 'string' && typeof child !== 'symbol') {
          walk(child as TemplateChildNode)
        }
      }
    }
  }

  /**
   * True when `prop` sits to the left of a `v-for` on the same element and
   * references the binding that `v-for` introduces.
   *
   * Emitted output is ordered by source offset, so such an expression lands
   * before the `.map(alias => {` that declares the alias. Emitting it would
   * produce two false reports at once -- the alias undefined at the use site,
   * and unused at the binding.
   */
  function precedesOwnScope(prop: DirectiveNode, node: ElementNode): boolean {
    const vFor = node.props.find(
      (p): p is DirectiveNode =>
        p.type === NodeTypes.DIRECTIVE && p.name === 'for' && !!p.forParseResult,
    )
    if (!vFor || vFor.loc.start.offset < prop.loc.start.offset) return false

    const r = vFor.forParseResult!
    // The three slots are ExpressionNode, a union whose compound variant has
    // no `content`; only the simple form names an identifier.
    const names = [r.value, r.key, r.index]
      .map(n => (n?.type === NodeTypes.SIMPLE_EXPRESSION ? n.content.trim() : ''))
      .filter(n => n && IDENTIFIER.test(n))
    if (!names.length) return false

    const text = String(prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION
      ? prop.exp.content
      : '')
    return names.some(n => new RegExp(`\\b${n}\\b`).test(text))
  }

  /** `my-widget` / `my_widget` -> `MyWidget`, matching Vue's tag resolution. */
  function pascalCase(tag: string): string {
    return tag
      .split(/[-_]/)
      .filter(Boolean)
      .map(p => p[0]!.toUpperCase() + p.slice(1))
      .join('')
  }

  /**
   * Emit a reference to the component a tag resolves to.
   *
   * Only COMPONENT tags qualify, so lowercase HTML elements are skipped. Vue
   * matches `<my-widget>` against a `MyWidget` binding, so the PascalCase form
   * is preferred when the literal tag text is not itself a valid identifier.
   */
  function emitComponentReference(node: ElementNode): void {
    if (node.tagType !== ElementTypes.COMPONENT) return
    const tag = node.tag
    if (!tag || tag.includes('.')) return // `<foo.bar>` is a member expression
    if (BUILTIN_COMPONENTS.test(tag)) return

    const ident = IDENTIFIER.test(tag) ? tag : pascalCase(tag)
    if (!IDENTIFIER.test(ident)) return

    // `<` is at loc.start; the name follows immediately after it.
    const start = node.loc.start.offset
    const at = start + 1

    // `typeof X` is the ideal form: it marks X as *used* (so a template-only
    // import is not reported unused) while being legal for an identifier that
    // was never declared -- which matters because a component may come from a
    // Nuxt/unplugin auto-import or a global registration that this file cannot
    // see. A bare `X` would make every such tag a `no-undef` false positive.
    //
    // The tag name itself is ours to overwrite, so the scan for extra room
    // starts just past it. Two things bound how far it may run:
    //
    // - the first child, because children are emitted before their parent and
    //   `<ElIcon><Delete /></ElIcon>` would otherwise let the outer tag write
    //   over the inner one's reference;
    // - a scope opener (`v-for` / `v-slot`), because it is written into its own
    //   directive span *after* this runs and does not consult the ledger.
    //   `<ElFormItem v-for="f in fields">` produced the spliced identifier
    //   `ElForfields`, silently destroying both references. Ordinary props
    //   need no such bound: they are emitted first and the ledger covers them.
    const firstChild = node.children[0]
    const scopeOpener = node.props.find(
      p => p.type === NodeTypes.DIRECTIVE && (p.name === 'for' || p.name === 'slot'),
    )
    const limit = Math.min(
      scopeOpener ? scopeOpener.loc.start.offset : Number.POSITIVE_INFINITY,
      firstChild ? firstChild.loc.start.offset : Number.POSITIVE_INFINITY,
      node.loc.end.offset,
    )
    const wide = Math.min(freePaddingEnd(at + tag.length), limit, chars.length)

    // The trailing `;` is required, not decorative: without it the identifier
    // can butt straight up against whatever was emitted next (`typeof VForm`
    // followed immediately by a `ref` reference would read as `VFormformRef`).
    if (writeAt(chars, start, `typeof ${ident};`, wide)) {
      claim(start, start + ident.length + 8)
      return
    }

    // `<Tight/>` has no attributes and no children, so there is no padding to
    // borrow and `typeof ` (6 extra chars) cannot fit. ~5% of component tags in
    // practice. The bare identifier still marks the binding as used; the only
    // cost is that an auto-imported component in this shape can trip no-undef.
    const narrow = at + tag.length + 1
    if (narrow > chars.length) return
    // Prefer a trailing `;`, but a tag at end-of-line (`<OrderHeader\n  :a=..`)
    // has a newline right after the name, and writeAt refuses to clobber it.
    // The bare identifier is fine there -- ASI terminates the statement.
    if (writeAt(chars, at, `${ident};`, narrow)) {
      claim(at, at + ident.length + 1)
      return
    }
    if (writeAt(chars, at, ident, narrow)) claim(at, at + ident.length)
  }

  /**
   * Scan forward from `from` while the buffer holds only padding we are free to
   * reuse, returning the first offset that is not.
   *
   * `written` records every region already emitted (expressions, refs), which
   * may legitimately contain spaces -- so a space alone does not prove the slot
   * is free. Checking the ledger is what prevents `typeof VForm` from running
   * into an adjacent `formRef`.
   */
  function freePaddingEnd(from: number): number {
    let i = from
    while (i < chars.length && chars[i] === ' ' && !written.has(i)) i++
    return i
  }

  /**
   * Emit `ref="name"` as a reference to `name`, when it looks like a plain
   * identifier. The quoted text sits at known offsets, so the identifier is
   * written exactly over its own characters.
   */
  function emitStaticRef(value: NonNullable<AttributeNode['value']>): void {
    const content = value.content
    if (!content || !IDENTIFIER.test(content)) return

    // value.loc spans the quotes; the content starts one character in.
    const at = value.loc.start.offset + 1
    if (source.slice(at, at + content.length) !== content) return

    const budget = at + content.length + 1
    if (budget > chars.length) return
    if (writeAt(chars, at, `${content};`, budget)) {
      claim(at, at + content.length + 1)
      return
    }
    if (writeAt(chars, at, content, budget)) claim(at, at + content.length)
  }

  /**
   * `v-maska` resolves to a `vMaska` binding in `<script setup>`, so the
   * directive is a real reference. Written over the directive name itself,
   * which is always at least as long as the identifier (`v-maska` is 7 chars,
   * `vMaska` is 6).
   */
  function emitDirectiveReference(prop: DirectiveNode): void {
    const name = prop.name
    if (!name || BUILTIN_DIRECTIVES.has(name)) return

    const ident = `v${pascalCase(name)}`
    if (!IDENTIFIER.test(ident)) return

    // prop.loc starts at `v-`; the full directive text is `v-name=...`.
    const at = prop.loc.start.offset
    const budget = at + name.length + 2 // `v-` + name
    if (budget > chars.length) return

    if (writeAt(chars, at, `${ident};`, budget)) {
      claim(at, at + ident.length + 1)
      return
    }
    if (writeAt(chars, at, ident, budget)) claim(at, at + ident.length)
  }

  /**
   * A plain expression becomes a statement. We surround it with `;(` and `);`
   * where padding allows, which keeps it a valid expression statement even when
   * it is an object literal or a sequence.
   */
  function emitExpression(exp: DirectiveNode['exp']): void {
    if (!exp || exp.type !== NodeTypes.SIMPLE_EXPRESSION) return
    const simple = exp as SimpleExpressionNode
    if (simple.isStatic) return

    const start = simple.loc.start.offset
    const end = simple.loc.end.offset
    if (end <= start) return

    // Expressions starting with `{` or `function` are ambiguous at statement
    // position: `{...}` parses as a block, not an object literal. Those MUST be
    // parenthesised, so the bare fallbacks are not offered for them.
    const text = source.slice(start, end).trimStart()
    const needsParens = text.startsWith('{') || text.startsWith('function')

    // Vue permits several statements in one handler (`@click="a(); b()"`). That
    // is a statement list, not an expression, so parenthesising it is a syntax
    // error -- leave it bare and let the surrounding padding terminate it.
    if (!needsParens && hasTopLevelSemicolon(text)) {
      for (let i = start; i < end; i++) chars[i] = source[i]!
      claim(start, end)
      out.push({ start, end, statements: true })
      return
    }

    // The padding to either side is the blanked attribute name, `="`, `"` and
    // `{{ }}`, so a couple of characters is typical and ~8 is available in
    // practice. Bounded so we never reach into a neighbouring construct.
    const slotStart = Math.max(0, start - 8)
    const slotEnd = Math.min(chars.length, end + 8)

    const wrappers = needsParens
      ? [
          { prefix: ';(', suffix: ');' },
          { prefix: '(', suffix: ');' },
          { prefix: '(', suffix: ')' },
        ]
      : [
          { prefix: ';(', suffix: ');' },
          { prefix: '(', suffix: ');' },
          { prefix: ';', suffix: ';' },
          { prefix: '', suffix: ';' },
          { prefix: ';', suffix: '' },
        ]

    // Restore the raw expression text at its original offsets.
    for (let i = start; i < end; i++) chars[i] = source[i]!

    for (const w of wrappers) {
      if (wrapExpression(chars, { start, end, slotStart, slotEnd, ...w })) {
        claim(start - w.prefix.length, end + w.suffix.length)
        out.push({ start, end })
        return
      }
    }

    if (needsParens) {
      // Could not parenthesise a brace/function expression. Leaving it bare
      // would be a syntax error, which silently disables every rule for the
      // whole file -- far worse than losing this one expression. Blank it.
      blankRegion(chars, start, end)
      return
    }

    // No wrapper fits. A bare expression is still valid as a statement as long
    // as ASI can terminate it, which holds because every neighbour is padding
    // or a newline. Keep it: losing the expression loses real diagnostics.
    claim(start, end)
    out.push({ start, end, bare: true })
  }

  /**
   * v-for / v-slot: emit a real binding construct so oxlint's scope analyser
   * creates the binding itself.
   *
   *   v-for="item in items"  ->  items.map(item=>{        ... })
   *   v-slot="{ row }"       ->  (({ row })=>{            ... })
   *
   * Both the iterated source and the binding pattern keep their ORIGINAL
   * offsets, so `no-unused-vars` on the loop variable and `no-undef` on the
   * source point at the right place in the .vue file. The closing `})` is
   * parked in the element's closing tag, which is padding by then.
   */
  function emitScope(
    prop: DirectiveNode,
    node: ElementNode,
    deferred: DirectiveNode['exp'][] = [],
  ): void {
    const dirStart = prop.loc.start.offset
    const dirEnd = prop.loc.end.offset

    if (prop.name === 'for') {
      const r = prop.forParseResult
      if (!r?.source || !r.value) return

      const srcText = source.slice(r.source.loc.start.offset, r.source.loc.end.offset)
      const valText = source.slice(r.value.loc.start.offset, r.value.loc.end.offset)

      // `v-for="i in 5"` would yield `5.map(...)`, where `5.` is a malformed
      // number. Any non-identifier source is also safer parenthesised.
      const srcSafe = IDENTIFIER.test(srcText.trim()) ? srcText : `(${srcText})`
      // Destructuring patterns (`[a, b]`, `{ a }`) are not valid as a bare
      // arrow parameter -- they must be parenthesised.
      const valSafe = IDENTIFIER.test(valText.trim()) ? valText : `(${valText})`

      const open = `${srcSafe}.map(${valSafe}=>{`
      // Parenthesising costs up to 4 extra characters, which may no longer fit
      // in the directive's own span; fall back to padding rather than corrupt.
      if (!writeAt(chars, dirStart, open, dirEnd)) {
        blankRegion(chars, dirStart, dirEnd)
        return
      }
      if (!closeScope(node, dirEnd)) {
        blankRegion(chars, dirStart, dirEnd)
        return
      }
      emitDeferred(deferred, dirStart + open.length, node)
      out.push({ start: dirStart, end: dirEnd, kind: 'v-for' })
      return
    }

    if (prop.name === 'slot' && prop.exp) {
      const expText = source.slice(prop.exp.loc.start.offset, prop.exp.loc.end.offset)
      const open = `((${expText})=>{`
      if (!writeAt(chars, dirStart, open, dirEnd)) return
      if (!closeScope(node, dirEnd)) {
        blankRegion(chars, dirStart, dirEnd)
        return
      }
      out.push({ start: dirStart, end: dirEnd, kind: 'v-slot' })
    }
  }

  /**
   * Write the deferred uses into the scope body that now exists.
   *
   * These are expressions written to the left of their own `v-for`
   * (`<component :is="node" v-for="(node) in list">`). Emitting them in place
   * would put the use before the binding; emitting them here, just inside
   * `map(node => {`, matches what Vue actually does. Only bare identifiers are
   * re-emitted: a full expression rarely fits, and the identifier alone is
   * what `no-unused-vars` needs on both ends.
   */
  function emitDeferred(
    deferred: DirectiveNode['exp'][],
    from: number,
    node: ElementNode,
  ): void {
    if (!deferred.length) return

    const names = deferred
      .map(e => (e?.type === NodeTypes.SIMPLE_EXPRESSION ? e.content.trim() : ''))
      .filter(n => n && IDENTIFIER.test(n))
    if (!names.length) return

    const text = `${[...new Set(names)].join(';')};`
    // The body runs from just past the opener to the element's end; the closer
    // was parked at its tail, so scan forward for a free run before it.
    const limit = node.loc.end.offset
    for (let at = from; at + text.length <= limit; at++) {
      if (canWrite(chars, at, text.length, limit)
        && !written.has(at)
        && chars.slice(at, at + text.length).every(c => c === ' ')) {
        writeAt(chars, at, text, at + text.length)
        claim(at, at + text.length)
        return
      }
    }
  }

  /**
   * Park a scope closer in the element's trailing padding. Prefers the closing
   * tag (`</p>`), falling back to the self-closing `/>`. Returns false when
   * there is genuinely no room, so the caller can back the whole thing out.
   */
  function closeScope(node: ElementNode, notBefore: number, closer = '});'): boolean {
    const end = node.loc.end.offset
    const start = Math.max(notBefore, node.loc.start.offset)
    // Scan backwards for a run of padding wide enough to hold the closer.
    for (let at = end - closer.length; at >= start; at--) {
      let free = true
      for (let i = 0; i < closer.length; i++) {
        if (chars[at + i] !== ' ') { free = false; break }
      }
      if (free) {
        writeAt(chars, at, closer, at + closer.length)
        return true
      }
    }
    return false
  }
}
