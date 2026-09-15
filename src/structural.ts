import type {
  AttributeNode,
  DirectiveNode,
  ElementNode,
  InterpolationNode,
  RootNode,
  SimpleExpressionNode,
  TemplateChildNode,
} from '@vue/compiler-core'
import type { Diagnostic, RuleConfig, RulesMap } from './types.js'
/**
 * Structural template rules.
 *
 * Padding deliberately destroys template structure -- it keeps expressions and
 * throws away tags, attributes and nesting. These rules recover that half by
 * walking the compiler-sfc template AST directly. No scope analysis and no
 * position mapping is needed here: the AST already carries .vue offsets.
 *
 * Node type constants from @vue/compiler-core NodeTypes.
 */
import { isHTMLTag, isSVGTag, isMathMLTag, isVoidTag } from '@vue/shared'
import { parse } from '@vue/compiler-sfc'
import { scriptPropMutations, templatePropMutations } from './prop-mutations.js'
import { analyzeScript } from './script-analysis.js'
import type { ScriptAnalysis } from './script-analysis.js'
import { componentDefinitionOffsets, componentNameFindings, componentOrderFindings, componentPublicNames, computedPropertyInfo, explicitEmitInfo, freeIdentifiers, refOperandFindings, registeredComponents, scriptInstanceMembers, validDefaultPropFindings } from './script-rules.js'
import type { ExplicitEmitInfo } from './script-rules.js'
import { bindingNames, expressionAst, astKey, staticName, unwrap } from './ast.js'
import { NodeTypes, baseParse, walkIdentifiers } from '@vue/compiler-core'

/** Any node the walker may hand a rule. */
type AnyNode = RootNode | TemplateChildNode

/* eslint-disable no-underscore-dangle -- These live on compiler-sfc's own AST
   nodes, not on ours. The `__` prefix marks them as foreign and keeps them
   from ever colliding with a field the Vue compiler adds later. */

/**
 * Context a rule needs but the node itself does not carry, stashed on the node
 * by `annotate` before the traversal reaches it.
 */
interface Annotations {
  /** The `v-else-if` siblings that continue the chain this node opens. */
  __siblings?: ElementNode[]
  /** Whether the preceding element sibling carries v-if or v-else-if. */
  __prevElementHasIf?: boolean
  /** Whether this element is nested below an outer v-for element. */
  __insideVFor?: boolean
  /** Raw tag name of the containing template element. */
  __parentTag?: string
  __parentElement?: ElementNode
  __nextElement?: ElementNode
  __firstElementChild?: boolean
  __depth?: number
  /** Full SFC source and template-content boundary for root-only checks. */
  __source?: string
  __templateContentStart?: number
  /** Identifiers declared by `defineProps` in `<script setup>`. */
  __script?: ScriptAnalysis
  __locals?: Set<string>
  __outerLocals?: Set<string>
  __computedNames?: Set<string>
  __scriptNames?: Set<string>
  __emitInfo?: ExplicitEmitInfo
}

type AnnotatedElement = ElementNode & Annotations

/**
 * What a rule passes to `report`: a diagnostic minus the ambient fields.
 *
 * `offset` is written explicitly on every payload (via `loc`) and may be
 * `undefined` when the node carries no location, so under
 * `exactOptionalPropertyTypes` it has to admit `undefined` as a value rather
 * than merely be optional.
 */
type ReportPayload = Omit<Diagnostic, 'filename' | 'severity' | 'rule' | 'offset'> & {
  offset: number | undefined
}

type Report = (d: ReportPayload) => void

interface Rule {
  name: string
  severity: 'error' | 'warning'
  check: (node: AnyNode, report: Report, options: Record<string, unknown>) => void
}

function loc(node: { loc?: AnyNode['loc'] }): {
  line: number
  column: number
  offset: number | undefined
} {
  const s = node.loc?.start
  return { line: s?.line ?? 1, column: s?.column ?? 1, offset: s?.offset }
}

/** The props array is only present on elements; other nodes have none. */
function propsOf(node: AnyNode): ElementNode['props'] {
  return node.type === NodeTypes.ELEMENT ? node.props : []
}

function findDir(node: AnyNode, name: string): DirectiveNode | undefined {
  return propsOf(node).find(
    (p): p is DirectiveNode => p.type === NodeTypes.DIRECTIVE && p.name === name,
  )
}

function findAttr(node: AnyNode, name: string): AttributeNode | undefined {
  return propsOf(node).find(
    (p): p is AttributeNode => p.type === NodeTypes.ATTRIBUTE && p.name === name,
  )
}

/** The `content` of a directive argument, when it is a static simple expression. */
function argContent(prop: DirectiveNode): string | undefined {
  const arg = prop.arg
  if (!arg || arg.type !== NodeTypes.SIMPLE_EXPRESSION || !arg.isStatic) return undefined
  return arg.content
}

/** Directive bound via `:key` / `v-bind:key`, or a static `key` attribute. */
function hasKeyBinding(node: AnyNode): boolean {
  if (findAttr(node, 'key')) return true
  return propsOf(node).some(p =>
    p.type === NodeTypes.DIRECTIVE
    && p.name === 'bind'
    && argContent(p) === 'key')
}

/** Optional computed keys are fine; an optional receiver is not writable. */
function hasOptionalReceiver(node: import('./ast.js').AstNode): boolean {
  node = unwrap(node)
  if (node.type === 'NullLiteral' || node.type === 'OptionalMemberExpression' || node.type === 'OptionalCallExpression') return true
  return node.type === 'MemberExpression' && hasOptionalReceiver(node.object)
}

function ruleOptions(config: RuleConfig | undefined): Record<string, unknown> {
  const option = Array.isArray(config) ? config[1] : undefined
  const secondary = Array.isArray(config) ? config[2] : undefined
  const rawOptions = Array.isArray(config) ? config.slice(1) : []
  return option && typeof option === 'object'
    ? { ...(option as Record<string, unknown>), secondary, rawOptions, configured: config !== undefined }
    : { mode: option, secondary, rawOptions, configured: config !== undefined }
}

/** Free names only: callback parameters do not refer to loop bindings. */
function referencesAny(exp: DirectiveNode['exp'], names: Set<string>): boolean {
  const ast = expressionAst(exp)
  let found = false
  if (ast) walkIdentifiers(ast, id => { if (names.has(id.name)) found = true })
  return found
}

function stringLiteral(exp: DirectiveNode['exp'], options: Record<string, unknown>): boolean {
  const ast = expressionAst(exp)
  if (!ast || (ast.type !== 'StringLiteral'
    && !(ast.type === 'TemplateLiteral' && ast.expressions.length === 0))) return false
  if (options.ignoreIncludesComment && ('comments' in ast && Array.isArray(ast.comments) && ast.comments.length
    || ast.leadingComments?.length || ast.trailingComments?.length)) return false
  const raw = ast.type === 'StringLiteral' ? String(ast.extra?.raw ?? '').slice(1, -1)
    : ast.quasis[0]?.value.raw ?? ''
  // Escaped quotes/backslashes are harmless; control/unicode escapes aren't.
  if (options.ignoreStringEscape) {
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '\\' && 'nrvtbfux'.includes(raw[++i] ?? '')) return false
    }
  }
  return true
}

function numericLimit(value: unknown): number {
  return typeof value === 'number' ? value
    : value && typeof value === 'object' && typeof (value as { max?: unknown }).max === 'number'
      ? (value as { max: number }).max : 1
}

function configuredNameMatch(value: string, patterns: unknown): boolean {
  if (!Array.isArray(patterns)) return false
  return patterns.some(pattern => {
    if (typeof pattern !== 'string') return false
    const match = pattern.match(/^\/(.*)\/([a-z]*)$/u)
    try { return match ? new RegExp(match[1]!, match[2]).test(value) : pattern === value } catch { return false }
  })
}

function kebabToCamel(value: string): string {
  return value.replace(/-([a-z])/gu, (_, char: string) => char.toUpperCase())
}

function optionList(options: Record<string, unknown>): unknown[] {
  return Array.isArray(options.rawOptions) ? options.rawOptions : []
}

function patternMatches(value: string, pattern: unknown): boolean {
  return configuredNameMatch(value, [pattern])
}

interface StaticClassValue {
  value: string
  node: import('./ast.js').AstNode
}

interface ClassFragment extends StaticClassValue {
  unconditional: boolean
  parent?: import('./ast.js').AstNode
}

/** Static class fragments that Vue can determine without evaluating runtime state. */
function staticClassValues(node: import('./ast.js').AstNode, textOnly = false): StaticClassValue[] {
  node = unwrap(node)
  if (node.type === 'StringLiteral') return [{ value: node.value, node }]
  if (node.type === 'TemplateLiteral') {
    return [
      ...node.quasis.map(quasi => ({ value: quasi.value.cooked ?? '', node: quasi as import('./ast.js').AstNode })),
      ...node.expressions.flatMap(exp => staticClassValues(exp, true)),
    ]
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return [...staticClassValues(node.left, true), ...staticClassValues(node.right, true)]
  }
  if (textOnly) return []
  if (node.type === 'ArrayExpression') {
    return node.elements.flatMap(element => element && element.type !== 'SpreadElement'
      ? staticClassValues(element) : [])
  }
  if (node.type === 'ObjectExpression') {
    return node.properties.flatMap(property => {
      if (property.type !== 'ObjectProperty') return []
      const name = staticName(property.key)
      return name === null ? [] : [{ value: name, node: property.key }]
    })
  }
  if (node.type === 'ConditionalExpression') {
    return [...staticClassValues(node.consequent), ...staticClassValues(node.alternate)]
  }
  if (node.type === 'LogicalExpression') {
    return [...staticClassValues(node.left), ...staticClassValues(node.right)]
  }
  return []
}

function classNames(value: string): string[] {
  return value.split(/\s+/u).filter(Boolean)
}

function deprecatedInstanceRule(name: '$listeners' | '$scopedSlots'): Rule {
  return {
    name: `vue/no-deprecated-dollar-${name === '$listeners' ? 'listeners' : 'scopedslots'}-api`,
    severity: 'error',
    check(node, report) {
      const expressions = node.type === NodeTypes.INTERPOLATION ? [node.content]
        : node.type === NodeTypes.ELEMENT ? node.props.flatMap(prop =>
          prop.type === NodeTypes.DIRECTIVE && prop.exp ? [prop.exp] : []) : []
      const locals = (node as AnyNode & Annotations).__locals
      for (const exp of expressions) {
        const ast = expressionAst(exp)
        if (!ast) continue
        for (const identifier of freeIdentifiers(ast, new Set([name]), locals)) {
          report({ ...astLoc(exp, identifier, ast), message: `The ${name} instance property is deprecated.` })
        }
      }
    },
  }
}

function classValueLoc(
  exp: NonNullable<DirectiveNode['exp']>,
  node: import('./ast.js').AstNode,
  root: import('./ast.js').AstNode,
): ReturnType<typeof loc> {
  if (node.type === 'TemplateElement') return relativeLoc(exp, Math.max(0, (node.start ?? 1) - 2))
  return (node.start ?? 0) <= 1 ? loc(exp) : astLoc(exp, node, root)
}

function classFragments(
  node: import('./ast.js').AstNode,
  unconditional = true,
  parent?: import('./ast.js').AstNode,
): ClassFragment[] {
  node = unwrap(node)
  if (node.type === 'StringLiteral') return [{ value: node.value, node, unconditional, ...(parent ? { parent } : {}) }]
  if (node.type === 'TemplateLiteral') return [
    ...node.quasis.map(quasi => ({ value: quasi.value.raw, node: quasi as import('./ast.js').AstNode, unconditional, parent: node })),
    ...node.expressions.flatMap(exp => classFragments(exp, unconditional, node)),
  ]
  if (node.type === 'ArrayExpression') return node.elements.flatMap(element =>
    element && element.type !== 'SpreadElement' ? classFragments(element, unconditional, node) : [])
  if (node.type === 'ObjectExpression') return node.properties.flatMap(property => {
    if (property.type !== 'ObjectProperty') return []
    const name = staticName(property.key)
    return name === null ? [] : [{ value: name, node: property.key, unconditional: false, parent: node }]
  })
  if (node.type === 'ConditionalExpression') return [
    ...classFragments(node.consequent, false, node), ...classFragments(node.alternate, false, node),
  ]
  if (node.type === 'BinaryExpression' && node.operator === '+') return [
    ...classFragments(node.left, unconditional, node), ...classFragments(node.right, unconditional, node),
  ]
  if (node.type === 'LogicalExpression') return [
    ...classFragments(node.left, unconditional, node), ...classFragments(node.right, false, node),
  ]
  return []
}

function separateStaticClassValues(node: import('./ast.js').AstNode): StaticClassValue[] {
  node = unwrap(node)
  if (node.type === 'StringLiteral') return [{ value: node.value, node }]
  if (node.type === 'TemplateLiteral') return node.quasis.flatMap((quasi, index) => {
    const value = quasi.value.cooked ?? ''
    const bounded = (index === 0 || /^\s/u.test(value))
      && (index === node.expressions.length || /\s$/u.test(value))
    return value.trim() && bounded ? [{ value: value.trim().replace(/\s+/gu, ' '), node: quasi as import('./ast.js').AstNode }] : []
  })
  if (node.type === 'ArrayExpression') return node.elements.flatMap(element =>
    element && element.type !== 'SpreadElement' ? separateStaticClassValues(element) : [])
  if (node.type === 'ObjectExpression') return node.properties.flatMap(property => {
    if (property.type !== 'ObjectProperty' || property.computed && property.key.type !== 'StringLiteral'
      || property.value.type !== 'BooleanLiteral' || property.value.value !== true) return []
    const name = staticName(property.key)
    return name === null ? [] : [{ value: name, node: property.key }]
  })
  return []
}

function directiveRestrictionMatches(
  item: unknown, name: string | undefined, modifiers: string[], tag: string,
): boolean {
  if (item === null) return name === undefined
  if (typeof item === 'string') return Boolean(name && configuredNameMatch(name, [item]))
  if (!item || typeof item !== 'object') return false
  const option = item as { argument?: unknown, modifiers?: unknown, element?: unknown }
  if (!directiveRestrictionMatches(option.argument, name, modifiers, tag)) return false
  if (Array.isArray(option.modifiers)
    && !option.modifiers.every(modifier => modifiers.includes(String(modifier)))) return false
  return typeof option.element !== 'string' || configuredNameMatch(tag, [option.element])
}

function customComponent(node: ElementNode, ignoreElementNamespaces = false): boolean {
  const native = node.tag === 'slot' || (ignoreElementNamespaces
    ? isHTMLTag(node.tag) || isSVGTag(node.tag) || isMathMLTag(node.tag)
    : node.ns === 0 ? isHTMLTag(node.tag) : node.ns === 1 ? isSVGTag(node.tag) : isMathMLTag(node.tag))
  return !native || !!findAttr(node, 'is')
    || node.props.some(p => p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && argContent(p) === 'is')
}

/** Locate a token relative to a compiler node without losing multiline offsets. */
function relativeLoc(node: { loc: AnyNode['loc'] }, relative: number): ReturnType<typeof loc> {
  const prefix = node.loc.source.slice(0, Math.max(0, relative))
  const lines = prefix.split('\n')
  return {
    offset: node.loc.start.offset + relative,
    line: node.loc.start.line + lines.length - 1,
    column: lines.length > 1 ? lines.at(-1)!.length + 1 : node.loc.start.column + relative,
  }
}

function sourceLoc(source: string, offset: number): ReturnType<typeof loc> {
  const lines = source.slice(0, offset).split('\n')
  return { offset, line: lines.length, column: lines.at(-1)!.length + 1 }
}

function normalizedTagName(name: string): string {
  return name.replaceAll('-', '').toLowerCase()
}

function attributeIsBind(prop: AttributeNode | DirectiveNode): boolean {
  return prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind'
}

function attributeIsModel(prop: AttributeNode | DirectiveNode): boolean {
  return prop.type === NodeTypes.DIRECTIVE && prop.name === 'model'
}

function attributeIsBindObject(prop: AttributeNode | DirectiveNode): boolean {
  return prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && !prop.arg
}

function attributeIsValueLike(prop: AttributeNode | DirectiveNode | undefined): boolean {
  return Boolean(prop && (prop.type === NodeTypes.ATTRIBUTE || attributeIsBind(prop) || attributeIsModel(prop)))
}

interface RawBlockTag {
  type: string
  start: number
  openEnd: number
  closeStart: number
  attrs: string
  content: string
}

function topLevelBlockTags(source: string): RawBlockTag[] {
  const blocks: RawBlockTag[] = []
  const stack: { type: string, start: number, openEnd: number, attrs: string, topLevel: boolean }[] = []
  for (const match of source.matchAll(/<\s*(\/?)\s*([\w-]+)([^<>]*?)(\/?)>/gu)) {
    const closing = match[1] === '/'
    const type = match[2]!
    if (closing) {
      const open = stack.pop()
      if (open?.topLevel) blocks.push({ ...open, type: open.type, closeStart: match.index,
        content: source.slice(open.openEnd, match.index) })
      continue
    }
    const openEnd = match.index + match[0].length
    const topLevel = stack.length === 0
    if (match[4] === '/') {
      if (topLevel) blocks.push({ type, start: match.index, openEnd, closeStart: openEnd,
        attrs: match[3] ?? '', content: '' })
    } else stack.push({ type, start: match.index, openEnd, attrs: match[3] ?? '', topLevel })
  }
  return blocks.toSorted((a, b) => a.start - b.start)
}

interface RawAttribute {
  name: string
  start: number
  valueStart?: number
}

/** Read attributes from one opening tag without inspecting quoted text or children. */
function openingAttributes(source: string): RawAttribute[] {
  const out: RawAttribute[] = []
  let index = source.indexOf('<') + 1
  while (index > 0 && index < source.length && !/[\s/>]/.test(source[index]!)) index++
  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index++
    if (!source[index] || source[index] === '>' || source.startsWith('/>', index)) break
    const start = index
    while (index < source.length && !/[\s=/>]/.test(source[index]!)) index++
    const name = source.slice(start, index)
    while (/\s/.test(source[index] ?? '')) index++
    let valueStart: number | undefined
    if (source[index] === '=') {
      index++
      while (/\s/.test(source[index] ?? '')) index++
      valueStart = index
      const quote = source[index] === '"' || source[index] === "'" ? source[index++] : undefined
      if (quote) while (index < source.length && source[index++] !== quote) { /* scan */ }
      else while (index < source.length && !/[\s>]/.test(source[index]!)) index++
    }
    out.push({ name, start, ...(valueStart === undefined ? {} : { valueStart }) })
  }
  return out
}

function astLoc(exp: NonNullable<DirectiveNode['exp']>, node: import('./ast.js').AstNode, root: import('./ast.js').AstNode): ReturnType<typeof loc> {
  const decodedOffset = Math.max(0, (node.start ?? 0) - (root.type === 'Program' ? 0 : 1))
  if (exp.type !== NodeTypes.SIMPLE_EXPRESSION || exp.content === exp.loc.source) return relativeLoc(exp, decodedOffset)
  // Babel sees decoded entities; compiler locations refer to the original SFC.
  // Decode only entity tokens, using the same compiler as the template parser.
  let raw = 0
  let decoded = 0
  while (raw < exp.loc.source.length && decoded < decodedOffset) {
    const entity = /^&(?:#x[\da-f]+|#\d+|[a-z][\da-z]*);/i.exec(exp.loc.source.slice(raw))?.[0]
    if (entity) {
      const text = baseParse(entity).children[0]
      if (text?.type === NodeTypes.TEXT && exp.content.startsWith(text.content, decoded)) {
        if (decoded + text.content.length > decodedOffset) break
        decoded += text.content.length
        raw += entity.length
        continue
      }
    }
    raw++
    decoded++
  }
  return relativeLoc(exp, raw)
}

function visitExpression(node: import('./ast.js').AstNode, visit: (node: import('./ast.js').AstNode) => void): void {
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') visitExpression(child, visit)
    }
  }
}

const normalizeComponentName = (name: string): string => name.replace(/-/g, '').toLowerCase()

function kebabComponentName(name: string): string {
  return name.replace(/([a-z\d])([A-Z])/g, '$1-$2').toLowerCase()
}

function pascalComponentName(name: string): string {
  return kebabComponentName(name).split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')
}

function matchesConfiguredName(patterns: unknown, name: string): boolean {
  if (!Array.isArray(patterns)) return false
  const candidates = [name, pascalComponentName(name), kebabComponentName(name)]
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string') return false
    const regex = /^\/(.*)\/([a-z]*)$/.exec(pattern)
    if (!regex) return candidates.includes(pattern)
    try { return candidates.some(candidate => new RegExp(regex[1]!, regex[2]).test(candidate)) } catch { return false }
  })
}

const validXmlName = (name: string): boolean => /^[A-Za-z_:][A-Za-z0-9_.:-]*$/u.test(name)

type Ast = import('./ast.js').AstNode
function splitConditions(ast: Ast, operator: string): Ast[] {
  return ast.type === 'LogicalExpression' && ast.operator === operator
    ? [...splitConditions(ast.left, operator), ...splitConditions(ast.right, operator)] : [ast]
}

function equalConditions(a: Ast, b: Ast): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'LogicalExpression' && b.type === 'LogicalExpression'
    && ['&&', '||'].includes(a.operator) && a.operator === b.operator) {
    return equalConditions(a.left, b.left) && equalConditions(a.right, b.right)
      || equalConditions(a.left, b.right) && equalConditions(a.right, b.left)
  }
  return astKey(a) === astKey(b)
}

/** These directives accept neither arguments nor modifiers. */
function simpleDirectiveRule(name: string, requiresValue: boolean): Rule {
  return {
    name: `vue/valid-v-${name}`,
    severity: 'error',
    check(node, report) {
      for (const dir of propsOf(node)) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== name) continue
        if (dir.arg) report({ message: `v-${name} does not accept an argument.`, ...loc(dir.arg) })
        if (dir.modifiers[0]) report({ message: `v-${name} does not accept modifiers.`, ...loc(dir.modifiers[0]) })
        if (requiresValue) {
          if (!dir.exp?.loc.source) report({ message: `v-${name} requires a value.`, ...loc(dir) })
        } else {
          // Include the opening quote, as the reference attribute-value node does.
          if (dir.exp) {
            const start = dir.exp.loc.start.offset - dir.loc.start.offset
            const quoted = ['"', "'"].includes(dir.loc.source[start - 1] ?? '')
            report({ message: `v-${name} does not accept a value.`, ...relativeLoc(dir, start - Number(quoted)) })
          }
        }
        if (name === 'show' && node.type === NodeTypes.ELEMENT && node.tag === 'template') {
          report({ message: 'v-show cannot be used on <template>.', ...loc(dir) })
        }
      }
    },
  }
}

function directiveValueLoc(dir: DirectiveNode): ReturnType<typeof loc> {
  const equals = dir.loc.source.indexOf('=')
  return equals < 0 ? loc(dir) : relativeLoc(dir, equals + 1)
}

function conditionalDirectiveRule(name: 'if' | 'else-if' | 'else'): Rule {
  return {
    name: `vue/valid-v-${name}`,
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const context = node as AnnotatedElement
      for (const dir of node.props) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== name) continue
        const otherIf = findDir(node, 'if')
        const otherElseIf = findDir(node, 'else-if')
        const otherElse = findDir(node, 'else')

        if (name !== 'if' && !context.__prevElementHasIf) report({
          message: `'v-${name}' must be preceded by an element with v-if or v-else-if.`,
          ...loc(dir),
        })
        if (name === 'if' && otherElse) report({
          message: 'v-if and v-else cannot exist on the same element.', ...loc(dir),
        })
        if (name === 'if' && otherElseIf) report({
          message: 'v-if and v-else-if cannot exist on the same element.', ...loc(dir),
        })
        if (name === 'else-if' && otherIf) report({
          message: 'v-else-if and v-if cannot exist on the same element.', ...loc(dir),
        })
        if (name === 'else-if' && otherElse) report({
          message: 'v-else-if and v-else cannot exist on the same element.', ...loc(dir),
        })
        if (name === 'else' && otherIf) report({
          message: 'v-else and v-if cannot exist on the same element.', ...loc(dir),
        })
        if (name === 'else' && otherElseIf) report({
          message: 'v-else and v-else-if cannot exist on the same element.', ...loc(dir),
        })
        if (dir.arg) report({ message: `'v-${name}' does not accept an argument.`, ...loc(dir.arg) })
        if (dir.modifiers[0]) report({ message: `'v-${name}' does not accept modifiers.`, ...loc(dir.modifiers[0]) })
        if (name === 'else') {
          if (dir.loc.source.includes('=')) report({
            message: 'v-else does not accept a value.', ...directiveValueLoc(dir),
          })
        } else if (!dir.exp?.loc.source) report({
          message: `'v-${name}' requires a value.`, ...loc(dir),
        })
      }
    },
  }
}

interface SlotSyntax {
  name: string
  modifiers: string[]
  modifierStart?: number
}

/** compiler-core folds dots in v-slot arguments into the argument text. */
function slotSyntax(dir: DirectiveNode): SlotSyntax {
  const raw = dir.rawName ?? dir.loc.source.split(/[\s=]/u, 1)[0] ?? 'v-slot'
  const body = raw.startsWith('#') ? raw.slice(1) : raw.startsWith('v-slot') ? raw.slice(6) : ''
  let argument = body
  if (argument.startsWith(':')) argument = argument.slice(1)
  if (argument.startsWith('[')) {
    const close = argument.indexOf(']')
    const rest = close < 0 ? '' : argument.slice(close + 1)
    const modifiers = rest.startsWith('.') ? rest.slice(1).split('.').filter(Boolean) : []
    return { name: argument.slice(0, close < 0 ? undefined : close + 1), modifiers,
      ...(modifiers.length ? { modifierStart: raw.indexOf('.', raw.indexOf(']')) + 1 } : {}) }
  }
  const parts = argument.split('.')
  const name = parts.shift() ?? ''
  const modifiers = parts.filter(Boolean)
  return { name: name || 'default', modifiers,
    ...(modifiers.length ? { modifierStart: raw.indexOf('.') + 1 } : {}) }
}

function slotDirectives(node: ElementNode): DirectiveNode[] {
  return node.props.filter((prop): prop is DirectiveNode =>
    prop.type === NodeTypes.DIRECTIVE && prop.name === 'slot')
}

function slotGroups(owner: ElementNode): ElementNode[][] {
  const groups: ElementNode[][] = []
  let previous: ElementNode | undefined
  for (const child of owner.children) {
    if (child.type !== NodeTypes.ELEMENT) continue
    const joinsPrevious = Boolean(previous && (findDir(child, 'else') || findDir(child, 'else-if'))
      && (findDir(previous, 'if') || findDir(previous, 'else-if')))
    if (joinsPrevious) groups.at(-1)!.push(child)
    else groups.push([child])
    previous = child
  }
  return groups
}

interface SlotLoopInfo { source: string, positions: (string | null)[], variables: string[] }

function slotLoopInfo(element: ElementNode, dir: DirectiveNode): SlotLoopInfo | null {
  const loop = findDir(element, 'for')?.forParseResult
  if (!loop || dir.arg?.type !== NodeTypes.SIMPLE_EXPRESSION || dir.arg.isStatic) return null
  const patterns = [loop.value, loop.key, loop.index]
  const names = patterns.flatMap(bindingNames)
  const ast = expressionAst(dir.arg)
  const used = ast ? freeIdentifiers(ast, new Set(names)).flatMap(identifier =>
    identifier.type === 'Identifier' ? [identifier.name] : []) : []
  if (!used.length) return null
  return { source: expContent(loop.source) ?? '', variables: used,
    positions: patterns.map(pattern => {
      const referenced = bindingNames(pattern).filter(name => used.includes(name))
      return referenced.length ? `${referenced.join(',')}:${expContent(pattern)}` : null
    }) }
}

function sameSlotLoop(a: SlotLoopInfo | null, b: SlotLoopInfo | null): boolean {
  if (!a || !b) return a === b
  if (a.source !== b.source) return false
  const checked = new Set<string>()
  for (let index = 0; index < Math.min(a.positions.length, b.positions.length); index++) {
    const left = a.positions[index]
    const right = b.positions[index]
    if (left !== right) return false
    if (left) for (const name of a.variables) if (left.startsWith(`${name}:`)) checked.add(name)
  }
  return a.variables.every(name => checked.has(name) || b.variables.includes(name))
}

function validVSlotRule(): Rule {
  return {
    name: 'vue/valid-v-slot',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const directives = slotDirectives(node)
      for (let index = 0; index < directives.length; index++) {
        const dir = directives[index]!
        const parent: ElementNode | undefined = (node as AnnotatedElement).__parentElement
        const owner: ElementNode | undefined = node.tag === 'template' ? parent : node
        // A top-level <template v-slot> has the document fragment as owner and
        // eslint-plugin-vue deliberately leaves it to the parser.
        if (!owner) {
          report({ message: "'v-slot' directive must be owned by a custom element, but 'template' is not.", ...loc(dir) })
          continue
        }
        const syntax = slotSyntax(dir)
        const isDefault = syntax.name === 'default'
        const childSlotGroups = slotGroups(owner).map(group => group.flatMap(element =>
          element.tag === 'template' ? slotDirectives(element) : []))
          .filter(group => group.length > 0)

        if (!customComponent(owner)) report({
          message: `'v-slot' directive must be owned by a custom element, but '${owner.tag}' is not.`,
          ...loc(dir),
        })
        if (!isDefault && node.tag !== 'template') report({
          message: "Named slots must use '<template>' on a custom element.", ...loc(dir),
        })
        if (owner === node && childSlotGroups.length > 0) report({
          message: "Default slot must use '<template>' on a custom element when there are other named slots.",
          ...loc(dir),
        })
        if (index > 0) report({
          message: "An element cannot have multiple 'v-slot' directives.", ...loc(dir),
        })

        if (owner === parent) {
          const currentGroup = childSlotGroups.findIndex(group => group.includes(dir))
          const normalizedName = [syntax.name, ...syntax.modifiers].join('.')
          const currentLoop = slotLoopInfo(node, dir)
          const sameGroups = childSlotGroups.filter(group => group.some(candidate => {
            if ([slotSyntax(candidate).name, ...slotSyntax(candidate).modifiers].join('.') !== normalizedName) return false
            const element = owner.children.find(child => child.type === NodeTypes.ELEMENT
              && slotDirectives(child).includes(candidate))
            return element?.type === NodeTypes.ELEMENT
              && sameSlotLoop(currentLoop, slotLoopInfo(element, candidate))
          }))
          const loop = findDir(node, 'for')
          const duplicate = (): void => report({
            message: "An element cannot have multiple '<template>' elements which are distributed to the same slot.",
            ...loc(dir),
          })
          if (loop && currentLoop === null) duplicate()
          if (sameGroups.length >= 2 && !sameGroups[0]?.includes(dir) && currentGroup >= 0) duplicate()
        }

        const slotParams = new Set(bindingNames(dir.exp))
        const argumentAst = dir.arg?.type === NodeTypes.SIMPLE_EXPRESSION && !dir.arg.isStatic
          ? expressionAst(dir.arg) : null
        if (argumentAst && freeIdentifiers(argumentAst, slotParams).length) report({
          message: "Dynamic argument of 'v-slot' directive cannot use that slot parameter.", ...loc(dir),
        })
        if (syntax.modifiers.length && (options.allowModifiers !== true || isDefault)) report({
          message: "'v-slot' directive doesn't support any modifier.",
          ...relativeLoc(dir, syntax.modifierStart ?? 0),
        })
        const emptyValue = !dir.exp?.loc.source.trim()
          || /^\s*(?:\/\*[\s\S]*?\*\/\s*)+$/u.test(dir.exp.loc.source)
        if (owner === node && isDefault && emptyValue) report({
          message: "'v-slot' directive on a custom element requires that attribute value.", ...loc(dir),
        })
      }
    },
  }
}

function invalidMemoExpression(node: Ast): boolean {
  return ['ObjectExpression', 'ClassExpression', 'ArrowFunctionExpression',
    'FunctionExpression', 'StringLiteral', 'NumericLiteral', 'BooleanLiteral',
    'NullLiteral', 'BigIntLiteral', 'DecimalLiteral', 'RegExpLiteral',
    'TemplateLiteral', 'UnaryExpression', 'BinaryExpression', 'UpdateExpression']
    .includes(node.type)
}

function checkMemoExpression(root: Ast, report: Report, exp: NonNullable<DirectiveNode['exp']>): void {
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()!
    if (invalidMemoExpression(node)) {
      report({ message: 'v-memo requires its value to be an array.', ...astLoc(exp, node, root) })
    } else if (node.type === 'AssignmentExpression') {
      pending.push(node.right)
    } else if (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion'
      || node.type === 'TypeCastExpression') {
      pending.push(node.expression)
    } else if (node.type === 'SequenceExpression') {
      const last = node.expressions.at(-1)
      if (last) pending.push(last)
    } else if (node.type === 'ConditionalExpression') {
      pending.push(node.alternate, node.consequent)
    }
  }
}

const SYSTEM_EVENT_MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'meta'])
const GLOBAL_EVENT_MODIFIERS = new Set([
  'stop', 'prevent', 'capture', 'self', 'once', 'passive', 'native',
])
const KEYBOARD_EVENTS = new Set(['keydown', 'keypress', 'keyup'])
const VALID_V_ON_MODIFIERS = new Set([
  'stop', 'prevent', 'capture', 'self', 'ctrl', 'shift', 'alt', 'meta', 'native',
  'once', 'left', 'right', 'middle', 'passive', 'esc', 'tab', 'enter', 'space',
  'up', 'down', 'delete', 'exact', 'arrow-down', 'arrow-left', 'arrow-right',
  'arrow-up',
])
const HTML_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])

interface EventDirective {
  directive: DirectiveNode
  name: string
  modifiers: string[]
  hasHandler: boolean
}

function eventModifierKey(event: EventDirective, system: boolean): string {
  return event.modifiers.filter(modifier =>
    system ? SYSTEM_EVENT_MODIFIERS.has(modifier)
      : !SYSTEM_EVENT_MODIFIERS.has(modifier) && !GLOBAL_EVENT_MODIFIERS.has(modifier),
  ).toSorted((a, b) => a.localeCompare(b)).join(',')
}

function keyboardStopWithoutHandler(event: EventDirective): boolean {
  return KEYBOARD_EVENTS.has(event.name) && event.modifiers.includes('stop')
    && !event.hasHandler
    && event.modifiers.every(modifier => GLOBAL_EVENT_MODIFIERS.has(modifier))
}

function eventModifiersConflict(base: EventDirective, event: EventDirective): boolean {
  if (event === base || event.modifiers.includes('exact')) return false
  if (base.modifiers.includes('exact') && keyboardStopWithoutHandler(event)) return false
  const eventKeys = eventModifierKey(event, false)
  const baseKeys = eventModifierKey(base, false)
  if (eventKeys && baseKeys && eventKeys !== baseKeys) return false
  const eventSystem = eventModifierKey(event, true)
  const baseSystem = eventModifierKey(base, true)
  return base.modifiers.length > 0 && baseSystem !== eventSystem
    && baseSystem.includes(eventSystem)
}

const RULES: Rule[] = [
  { name: 'vue/multi-word-component-names', severity: 'error', check() {} },
  { name: 'vue/no-unused-components', severity: 'error', check() {} },
  { name: 'vue/no-ref-as-operand', severity: 'error', check() {} },
  { name: 'vue/require-valid-default-prop', severity: 'error', check() {} },
  {
    name: 'vue/no-use-computed-property-like-method',
    severity: 'error',
    check(node, report) {
      const context = node as AnyNode & Annotations
      if (!context.__computedNames?.size) return
      const expressions = node.type === NodeTypes.INTERPOLATION ? [node.content]
        : node.type === NodeTypes.ELEMENT ? node.props.flatMap(prop =>
          prop.type === NodeTypes.DIRECTIVE && prop.exp ? [prop.exp] : []) : []
      for (const exp of expressions) {
        const ast = expressionAst(exp)
        if (!ast) continue
        const free = new Set(freeIdentifiers(ast, context.__computedNames, context.__locals))
        visitExpression(ast, candidate => {
          if (candidate.type === 'CallExpression' && candidate.callee.type === 'Identifier'
            && free.has(candidate.callee)) report({ ...astLoc(exp, candidate, ast),
              message: `Use ${candidate.callee.name} instead of ${candidate.callee.name}().` })
        })
      }
    },
  },
  {
    name: 'vue/no-template-shadow',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const context = node as AnnotatedElement
      const allowed = new Set(Array.isArray(options.allow) ? options.allow.map(String) : [])
      const seen = new Set(context.__outerLocals)
      const expressions = node.props.flatMap(prop => {
        if (prop.type !== NodeTypes.DIRECTIVE) return []
        if (prop.name === 'for' && prop.forParseResult) return [prop.forParseResult.value,
          prop.forParseResult.key, prop.forParseResult.index].filter(exp => exp !== undefined)
        return prop.name === 'slot' && prop.exp ? [prop.exp] : []
      })
      for (const exp of expressions) {
        let cursor = 0
        for (const name of bindingNames(exp)) {
          const match = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'u').exec(exp.loc.source.slice(cursor))
          const relative = cursor + (match?.index ?? 0)
          if (!allowed.has(name) && (seen.has(name) || context.__scriptNames?.has(name))) report({
            message: `Variable '${name}' is already declared in the upper scope.`, ...relativeLoc(exp, relative),
          })
          else seen.add(name)
          cursor = relative + name.length
        }
      }
    },
  },
  {
    name: 'vue/require-explicit-emits',
    severity: 'error',
    check(node, report) {
      const context = node as AnyNode & Annotations
      const info = context.__emitInfo
      if (!info || !info.hasDefinition || info.acceptsAny) return
      const expressions = node.type === NodeTypes.INTERPOLATION ? [node.content]
        : node.type === NodeTypes.ELEMENT ? node.props.flatMap(prop =>
          prop.type === NodeTypes.DIRECTIVE && prop.exp ? [prop.exp] : []) : []
      for (const exp of expressions) {
        const ast = expressionAst(exp)
        if (!ast) continue
        const free = new Set(freeIdentifiers(ast, info.templateEmitters, context.__locals))
        visitExpression(ast, candidate => {
          if (candidate.type !== 'CallExpression' || candidate.callee.type !== 'Identifier'
            || !free.has(candidate.callee) || candidate.arguments[0]?.type !== 'StringLiteral') return
          const name = candidate.arguments[0].value
          if (info.declared.has(name) || info.props.has(`on${name.charAt(0).toUpperCase()}${name.slice(1)}`)) return
          report({ ...astLoc(exp, candidate.arguments[0], ast),
            message: `The "${name}" event has been triggered but not declared.` })
        })
      }
    },
  },
  {
    name: 'vue/one-component-per-file',
    severity: 'error',
    check() {},
  },
  {
    name: 'vue/v-slot-style',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const configured = typeof options.mode === 'string'
        ? { atComponent: options.mode, default: options.mode, named: options.mode }
        : { atComponent: 'v-slot', default: 'shorthand', named: 'shorthand', ...options }
      for (const prop of node.props) {
        if (prop.type !== NodeTypes.DIRECTIVE || prop.name !== 'slot') continue
        const source = prop.loc.source
        const actual = source.startsWith('#') ? 'shorthand'
          : /^v-slot(?:\s|=|$)/u.test(source) ? 'v-slot' : 'longform'
        const isDefault = !prop.arg || prop.arg.type === NodeTypes.SIMPLE_EXPRESSION
          && prop.arg.isStatic && prop.arg.content === 'default'
        const expected = node.tag !== 'template' ? configured.atComponent
          : isDefault ? configured.default : configured.named
        if (actual !== expected) report({ message: `Expected ${expected} v-slot syntax.`, ...loc(prop) })
      }
    },
  },
  {
    name: 'vue/html-self-closing',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const html = options.html && typeof options.html === 'object'
        ? options.html as Record<string, unknown> : {}
      const mode = node.ns === 1 ? options.svg ?? 'always'
        : node.ns === 2 ? options.math ?? 'always'
          : isVoidTag(node.tag) ? html.void ?? 'never'
            : isHTMLTag(node.tag) ? html.normal ?? 'always' : html.component ?? 'always'
      if (mode === 'any') return
      if (mode === 'always' && !node.isSelfClosing && node.children.length === 0) {
        const relative = isVoidTag(node.tag) ? 0 : node.loc.source.lastIndexOf('</')
        report({ message: `Require self-closing on <${node.tag}>.`, ...relativeLoc(node, relative) })
      } else if (mode === 'never' && node.isSelfClosing) {
        report({ message: `Disallow self-closing on <${node.tag}/>.`, ...relativeLoc(node, node.loc.source.length - 2) })
      }
    },
  },
  {
    name: 'vue/no-multi-spaces',
    severity: 'error',
    check(node, report, options) {
      const scan = (text: string, base: number, expression = false): void => {
        const masked = [...text]
        if (expression) {
          let quote = ''
          for (let index = 0; index < text.length; index++) {
            const character = text[index]
            if (quote) {
              masked[index] = 'x'
              if (character === '\\') { if (index + 1 < text.length) masked[++index] = 'x' }
              else if (character === quote) quote = ''
            } else if (character === "'" || character === '"' || character === '`') {
              quote = character
              masked[index] = 'x'
            }
          }
        }
        const visible = masked.join('')
        for (const match of visible.matchAll(/[^\S\r\n]{2,}/gu)) {
          const index = match.index
          const lineStart = visible.lastIndexOf('\n', index - 1) + 1
          if (lineStart > 0 && visible.slice(lineStart, index).trim() === '') continue
          const before = visible.slice(0, index).trimEnd().at(-1)
          const after = visible.slice(index + match[0].length).trimStart()
          if (options.ignoreProperties === true && (before === ':' || after.startsWith(':'))) continue
          if (options.ignoreEOLComments === true && (after.startsWith('//') || after.startsWith('/*'))) continue
          report({ message: 'Multiple spaces found.',
            ...relativeLoc(node, base + index - node.loc.start.offset) })
        }
      }
      if (node.type === NodeTypes.INTERPOLATION) {
        const inner = node.loc.source.slice(2, -2)
        scan(inner, node.loc.start.offset + 2, true)
        return
      }
      if (node.type !== NodeTypes.ELEMENT) return
      const opening = node.loc.source
      let quote = ''
      let close = -1
      for (let index = 1; index < opening.length; index++) {
        const character = opening[index]
        if (quote) {
          if (character === quote) quote = ''
        } else if (character === "'" || character === '"') quote = character
        else if (character === '>') { close = index; break }
      }
      if (close >= 0) {
        const ranges: [number, number][] = node.props.length > 0
          ? [[node.tag.length + 1, node.props[0]!.loc.start.offset - node.loc.start.offset],
            ...node.props.slice(1).map((prop, index) => [
              node.props[index]!.loc.end.offset - node.loc.start.offset,
              prop.loc.start.offset - node.loc.start.offset,
            ] as [number, number]),
            [(node.props.at(-1)?.loc.end.offset ?? node.loc.start.offset) - node.loc.start.offset,
              close - (node.isSelfClosing ? 1 : 0)]]
          : [[node.tag.length + 1, close - (node.isSelfClosing ? 1 : 0)]]
        for (const [start, end] of ranges) scan(opening.slice(start, end), node.loc.start.offset + start)
      }
      for (const prop of node.props) {
        if (prop.type === NodeTypes.DIRECTIVE && prop.exp) {
          scan(prop.exp.loc.source, prop.exp.loc.start.offset, true)
        }
      }
    },
  },
  {
    name: 'vue/singleline-html-element-content-newline',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || node.isSelfClosing) return
      const inline = ['a', 'abbr', 'audio', 'b', 'bdi', 'bdo', 'canvas', 'cite', 'code', 'data', 'del',
        'dfn', 'em', 'i', 'iframe', 'ins', 'kbd', 'label', 'map', 'mark', 'noscript', 'object', 'output',
        'picture', 'q', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'svg', 'time', 'u',
        'var', 'video']
      const ignores = new Set(['pre', 'textarea', ...inline,
        ...(Array.isArray(options.ignores) ? options.ignores as string[] : []),
        ...(Array.isArray(options.externalIgnores) ? options.externalIgnores as string[] : []),
      ].map(normalizedTagName))
      let current: ElementNode | undefined = node
      while (current) {
        if (ignores.has(normalizedTagName(current.tag))) return
        current = (current as AnnotatedElement).__parentElement
      }
      if (options.ignoreWhenNoAttributes !== false && node.props.length === 0) return
      const source = node.loc.source
      let quote = ''
      let openingEnd = -1
      for (let index = 1; index < source.length; index++) {
        const character = source[index]
        if (quote) { if (character === quote) quote = '' }
        else if (character === "'" || character === '"') quote = character
        else if (character === '>') { openingEnd = index + 1; break }
      }
      const closingStart = source.lastIndexOf('</')
      if (openingEnd < 0 || closingStart < openingEnd) return
      if (source.slice(0, closingStart).includes('\n')) return
      const inner = source.slice(openingEnd, closingStart)
      if (inner.length === 0 && options.ignoreWhenEmpty !== false) return
      report({ message: 'Expected a line break after the opening tag.',
        ...relativeLoc(node, openingEnd) })
      if (inner.trim().length > 0) {
        const trailing = inner.length - inner.trimEnd().length
        report({ message: 'Expected a line break before the closing tag.',
          ...relativeLoc(node, closingStart - trailing) })
      }
    },
  },
  {
    name: 'vue/multiline-html-element-content-newline',
    severity: 'error',
    check(node, report, options) {
      if (node.type === NodeTypes.ROOT) {
        const full = (node as RootNode & Annotations).__source ?? ''
        const start = full.search(/<template\b/iu)
        const openingEnd = start < 0 ? -1 : full.indexOf('>', start) + 1
        const closingStart = full.lastIndexOf('</template')
        if (openingEnd <= start || closingStart < openingEnd
          || !full.slice(start, closingStart).includes('\n')) return
        const inner = full.slice(openingEnd, closingStart)
        if (inner.length === 0 && options.ignoreWhenEmpty !== false) return
        const leading = inner.length - inner.trimStart().length
        const trailing = inner.length - inner.trimEnd().length
        const beforeBreaks = (inner.slice(0, leading).match(/\n/gu) ?? []).length
        const afterBreaks = (inner.slice(inner.length - trailing).match(/\n/gu) ?? []).length
        const invalid = (count: number): boolean => options.allowEmptyLines === true ? count === 0 : count !== 1
        if (invalid(beforeBreaks)) report({ message: 'Expected one line break after the opening tag.',
          ...sourceLoc(full, openingEnd) })
        if (inner.trim().length > 0 && invalid(afterBreaks)) {
          report({ message: 'Expected one line break before the closing tag.',
            ...sourceLoc(full, closingStart - trailing) })
        }
        return
      }
      if (node.type !== NodeTypes.ELEMENT || node.isSelfClosing) return
      const inline = ['a', 'abbr', 'audio', 'b', 'bdi', 'bdo', 'canvas', 'cite', 'code', 'data', 'del',
        'dfn', 'em', 'i', 'iframe', 'ins', 'kbd', 'label', 'map', 'mark', 'noscript', 'object', 'output',
        'picture', 'q', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'svg', 'time', 'u',
        'var', 'video']
      const configuredIgnores = Array.isArray(options.ignores) ? options.ignores as string[]
        : ['pre', 'textarea', ...inline]
      const ignores = new Set(configuredIgnores.map(normalizedTagName))
      let current: ElementNode | undefined = node
      while (current) {
        if (ignores.has(normalizedTagName(current.tag))) return
        current = (current as AnnotatedElement).__parentElement
      }
      const source = node.loc.source
      let quote = ''
      let openingEnd = -1
      for (let index = 1; index < source.length; index++) {
        const character = source[index]
        if (quote) { if (character === quote) quote = '' }
        else if (character === "'" || character === '"') quote = character
        else if (character === '>') { openingEnd = index + 1; break }
      }
      const closingStart = source.lastIndexOf('</')
      if (openingEnd < 0 || closingStart < openingEnd || !source.slice(0, closingStart).includes('\n')) return
      const inner = source.slice(openingEnd, closingStart)
      if (inner.length === 0 && options.ignoreWhenEmpty !== false) return
      const leading = inner.length - inner.trimStart().length
      const trailing = inner.length - inner.trimEnd().length
      const beforeBreaks = (inner.slice(0, leading).match(/\n/gu) ?? []).length
      const afterBreaks = (inner.slice(inner.length - trailing).match(/\n/gu) ?? []).length
      const invalid = (count: number): boolean => options.allowEmptyLines === true ? count === 0 : count !== 1
      if (invalid(beforeBreaks)) report({ message: 'Expected one line break after the opening tag.',
        ...relativeLoc(node, openingEnd) })
      if (inner.trim().length > 0 && invalid(afterBreaks)) {
        report({ message: 'Expected one line break before the closing tag.',
          ...relativeLoc(node, closingStart - trailing) })
      }
    },
  },
  {
    name: 'vue/html-indent',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ROOT) return
      const source = (node as RootNode & Annotations).__source ?? ''
      const opening = source.search(/<template\b/iu)
      const contentStart = opening < 0 ? -1 : source.indexOf('>', opening) + 1
      const contentEnd = source.lastIndexOf('</template')
      if (contentStart <= opening || contentEnd < contentStart) return
      const width = options.mode === 'tab' ? 1
        : typeof options.mode === 'number' ? options.mode : 2
      const unit = options.mode === 'tab' ? '\t' : ' '.repeat(width)
      const baseIndent = typeof options.baseIndent === 'number' ? options.baseIndent : 1
      const content = source.slice(contentStart, contentEnd)
      let depth = baseIndent
      let offset = contentStart
      let pendingTag = false
      for (const [lineIndex, line] of content.split('\n').entries()) {
        const text = line.trimStart()
        const leading = line.slice(0, line.length - text.length)
        if (pendingTag && text.startsWith('/>')) { depth = Math.max(baseIndent, depth - 1); pendingTag = false }
        else if (pendingTag && text.startsWith('>')) pendingTag = false
        if (text && (text.startsWith('<') || text.startsWith('{{'))) {
          const closing = text.startsWith('</')
          const expectedDepth = Math.max(0, depth - (closing ? 1 : 0))
          const expected = unit.repeat(expectedDepth)
          const atLineStart = lineIndex > 0 || source[contentStart - 1] === '\n'
          if (atLineStart && leading !== expected) {
            report({ message: `Expected indentation of ${expected.length}.`, ...sourceLoc(source, offset) })
          }
          if (closing) depth = expectedDepth
          const opens = [...text.matchAll(/<([A-Za-z][\w:.-]*)\b[^>]*>/gu)]
            .filter(match => !match[0].endsWith('/>') && !isVoidTag(match[1] ?? '')).length
          const closes = [...text.matchAll(/<\/[A-Za-z][\w:.-]*\s*>/gu)].length
          depth = Math.max(baseIndent, depth + opens - closes + (closing ? 1 : 0))
          if (!closing && /^<[A-Za-z][\w:.-]*\b/u.test(text) && !text.includes('>')) {
            depth++
            pendingTag = true
          }
        }
        offset += line.length + 1
      }
    },
  },
  {
    name: 'vue/attributes-order',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || node.props.length < 2) return
      const other = ['ATTR_DYNAMIC', 'ATTR_STATIC', 'ATTR_SHORTHAND_BOOL']
      const defaults: (string | string[])[] = ['DEFINITION', 'LIST_RENDERING', 'CONDITIONALS',
        'RENDER_MODIFIERS', 'GLOBAL', ['UNIQUE', 'SLOT'], 'TWO_WAY_BINDING', 'OTHER_DIRECTIVES',
        other, 'EVENTS', 'CONTENT']
      const requested = Array.isArray(options.order) ? options.order as (string | string[])[] : defaults
      const order = requested.map(group => {
        if (group === 'OTHER_ATTR') return other
        if (Array.isArray(group) && group.includes('OTHER_ATTR')) {
          return [...group.filter(item => item !== 'OTHER_ATTR'), ...other]
        }
        return group
      })
      const positions = new Map<string, number>()
      for (const [index, group] of order.entries()) {
        for (const name of Array.isArray(group) ? group : [group]) positions.set(name, index)
      }
      const type = (prop: AttributeNode | DirectiveNode): string => {
        if (prop.type === NodeTypes.DIRECTIVE && !attributeIsBind(prop)) {
          if (prop.name === 'for') return 'LIST_RENDERING'
          if (['if', 'else-if', 'else', 'show', 'cloak'].includes(prop.name)) return 'CONDITIONALS'
          if (['pre', 'once'].includes(prop.name)) return 'RENDER_MODIFIERS'
          if (prop.name === 'model') return 'TWO_WAY_BINDING'
          if (prop.name === 'on') return 'EVENTS'
          if (['html', 'text'].includes(prop.name)) return 'CONTENT'
          if (prop.name === 'slot') return 'SLOT'
          if (prop.name === 'is') return 'DEFINITION'
          return 'OTHER_DIRECTIVES'
        }
        const name = prop.type === NodeTypes.ATTRIBUTE ? prop.name
          : prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic ? prop.arg.content : ''
        if (name === 'is') return 'DEFINITION'
        if (name === 'id') return 'GLOBAL'
        if (name === 'ref' || name === 'key') return 'UNIQUE'
        if (name === 'slot' || name === 'slot-scope') return 'SLOT'
        if (attributeIsBind(prop)) return 'ATTR_DYNAMIC'
        return prop.type === NodeTypes.ATTRIBUTE && !prop.value ? 'ATTR_SHORTHAND_BOOL' : 'ATTR_STATIC'
      }
      const name = (prop: AttributeNode | DirectiveNode): string => {
        if (prop.type === NodeTypes.ATTRIBUTE) return prop.name
        if (attributeIsBind(prop)) return prop.type === NodeTypes.DIRECTIVE ? prop.arg?.loc.source ?? '' : ''
        let key = `v-${prop.name}`
        if (prop.arg) key += `:${prop.arg.loc.source}`
        for (const modifier of prop.modifiers) key += `.${modifier.content}`
        return key
      }
      const props = node.props.filter((prop, index, all) => {
        if (!attributeIsBindObject(prop)) return true
        if (options.ignoreVBindObject === true) return false
        return !attributeIsValueLike(all[index - 1]) && !attributeIsValueLike(all[index + 1])
      })
      const entries = props.flatMap((prop, index) => {
        let position: number | undefined
        if (attributeIsBindObject(prop)) {
          for (const next of props.slice(index + 1)) {
            if (attributeIsValueLike(next) && !attributeIsBindObject(next)) { position = positions.get(type(next)); break }
          }
        }
        position ??= positions.get(type(prop))
        return position === undefined ? [] : [{ prop, position }]
      })
      if (entries.length < 2) return
      let previous = entries[0]!
      for (const current of entries.slice(1)) {
        let valid = previous.position <= current.position
        if (valid && previous.position === current.position) {
          let sortedByLength = false
          if (options.sortLineLength === true
            && previous.prop.loc.source.length !== current.prop.loc.source.length) {
            valid = previous.prop.loc.source.length < current.prop.loc.source.length
            sortedByLength = true
          }
          if (options.alphabetical === true && !sortedByLength) {
            const before = name(previous.prop)
            const after = name(current.prop)
            valid = before === after
              ? Number(attributeIsBind(previous.prop)) <= Number(attributeIsBind(current.prop)) : before < after
          }
        }
        if (valid) previous = current
        else report({ message: 'Attribute is out of order.', ...loc(current.prop) })
      }
    },
  },
  {
    name: 'vue/order-in-components',
    severity: 'error',
    check() {},
  },
  {
    name: 'vue/no-deprecated-filter',
    severity: 'error',
    check(node, report, options) {
      if (options.filterSyntax === false) return
      const expressions = node.type === NodeTypes.INTERPOLATION ? [node.content]
        : node.type === NodeTypes.ELEMENT ? node.props.flatMap(prop =>
          prop.type === NodeTypes.DIRECTIVE && prop.exp && prop.name !== 'for' ? [prop.exp] : []) : []
      for (const exp of expressions) {
        if (exp.type !== NodeTypes.SIMPLE_EXPRESSION || !/(^|[^|])\|([^|=]|$)/u.test(exp.content)) continue
        report({ message: 'Filters are deprecated.', ...loc(exp) })
      }
    },
  },
  deprecatedInstanceRule('$listeners'),
  deprecatedInstanceRule('$scopedSlots'),
  validVSlotRule(),
  ...['html', 'text', 'show'].map(name => simpleDirectiveRule(name, true)),
  ...['once', 'cloak'].map(name => simpleDirectiveRule(name, false)),
  ...(['if', 'else-if', 'else'] as const).map(conditionalDirectiveRule),
  {
    name: 'vue/valid-v-pre',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      for (const attr of openingAttributes(node.loc.source)) {
        if (attr.name !== 'v-pre' && !attr.name.startsWith('v-pre:')
          && !attr.name.startsWith('v-pre.')) continue
        const argument = attr.name.indexOf(':')
        const modifier = attr.name.indexOf('.')
        if (argument >= 0) report({
          message: 'v-pre does not accept an argument.', ...relativeLoc(node, attr.start + argument + 1),
        })
        if (modifier >= 0) report({
          message: 'v-pre does not accept modifiers.', ...relativeLoc(node, attr.start + modifier + 1),
        })
        if (attr.valueStart !== undefined) report({
          message: 'v-pre does not accept a value.', ...relativeLoc(node, attr.valueStart),
        })
      }
    },
  },
  {
    name: 'vue/no-deprecated-functional-template',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ROOT) return
      const context = node as RootNode & Annotations
      if (context.__source === undefined || context.__templateContentStart === undefined) return
      const beforeContent = context.__source.slice(0, context.__templateContentStart)
      const openingStart = beforeContent.lastIndexOf('<template')
      if (openingStart < 0) return
      const opening = beforeContent.slice(openingStart)
      const attr = openingAttributes(opening).find(candidate => candidate.name === 'functional')
      if (attr) report({
        message: 'Functional templates are deprecated in Vue 3.',
        ...sourceLoc(context.__source, openingStart + attr.start),
      })
    },
  },
  {
    name: 'vue/valid-v-memo',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      for (const dir of node.props) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'memo') continue
        if ((node as AnnotatedElement).__insideVFor) report({
          message: 'v-memo does not work inside v-for.', ...loc(dir),
        })
        if (dir.arg) report({ message: 'v-memo does not accept an argument.', ...loc(dir.arg) })
        if (dir.modifiers[0]) report({ message: 'v-memo does not accept modifiers.', ...loc(dir.modifiers[0]) })
        if (!dir.exp?.loc.source) {
          report({ message: 'v-memo requires a value.', ...loc(dir) })
          continue
        }
        const expression = expressionAst(dir.exp)
        if (expression && expression.type !== 'Program') checkMemoExpression(expression, report, dir.exp)
      }
    },
  },
  {
    name: 'vue/valid-v-is',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      for (const dir of node.props) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'is') continue
        if (dir.arg) report({ message: 'v-is does not accept an argument.', ...loc(dir.arg) })
        if (dir.modifiers[0]) report({ message: 'v-is does not accept modifiers.', ...loc(dir.modifiers[0]) })
        if (!dir.exp?.loc.source) report({ message: 'v-is requires a value.', ...loc(dir) })
        if (node.ns === 0 && !isHTMLTag(node.tag)) report({
          message: `v-is must be used on a native HTML element; <${node.tag}> is not one.`,
          ...loc(dir),
        })
      }
    },
  },
  {
    name: 'vue/no-deprecated-v-on-native-modifier',
    severity: 'error',
    check(node, report) {
      for (const dir of propsOf(node)) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'on') continue
        for (const modifier of dir.modifiers) if (modifier.content === 'native') report({
          message: '.native modifier on v-on is deprecated in Vue 3.', ...loc(modifier),
        })
      }
    },
  },
  {
    name: 'vue/use-v-on-exact',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      let events: EventDirective[] = node.props.flatMap((dir) => {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'on') return []
        return [{
          directive: dir,
          name: dir.arg?.loc.source ?? '',
          modifiers: dir.modifiers.map(modifier => modifier.content),
          hasHandler: Boolean(dir.exp),
        }]
      })
      if (customComponent(node)) events = events.filter(event => event.modifiers.includes('native'))
      const groups = new Map<string, EventDirective[]>()
      for (const event of events) {
        const group = groups.get(event.name) ?? []
        group.push(event)
        groups.set(event.name, group)
      }
      for (const sameName of groups.values()) {
        if (!sameName.some(event => event.modifiers.some(modifier => SYSTEM_EVENT_MODIFIERS.has(modifier)))) continue
        const conflicts: EventDirective[] = []
        for (const base of sameName) for (const event of sameName) {
          if (!conflicts.includes(event) && eventModifiersConflict(base, event)) conflicts.push(event)
        }
        for (const event of conflicts) report({
          message: 'Add the .exact modifier to avoid handling extra modifier combinations.',
          ...loc(event.directive),
        })
      }
    },
  },
  {
    name: 'vue/no-deprecated-v-is',
    severity: 'error',
    check(node, report) {
      for (const dir of propsOf(node)) if (dir.type === NodeTypes.DIRECTIVE && dir.name === 'is') report({
        message: 'v-is is deprecated.', ...loc(dir),
      })
    },
  },
  {
    name: 'vue/no-deprecated-v-bind-sync',
    severity: 'error',
    check(node, report) {
      for (const dir of propsOf(node)) if (dir.type === NodeTypes.DIRECTIVE && dir.name === 'bind'
        && dir.modifiers.some(modifier => modifier.content === 'sync')) report({
        message: 'The .sync modifier is deprecated; use v-model with an argument.', ...loc(dir),
      })
    },
  },
  {
    name: 'vue/no-deprecated-v-on-number-modifiers',
    severity: 'error',
    check(node, report) {
      for (const dir of propsOf(node)) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'on') continue
        const modifier = dir.modifiers.find((candidate) => {
          const number = Number(candidate.content)
          return Number.isSafeInteger(number) && (number > 9 || number < 0)
        })
        if (modifier) report({
          message: 'Numeric KeyboardEvent.keyCode modifiers are deprecated.', ...loc(modifier),
        })
      }
    },
  },
  {
    name: 'vue/no-deprecated-inline-template',
    severity: 'error',
    check(node, report) {
      const attr = findAttr(node, 'inline-template')
      if (attr) report({ message: 'The inline-template attribute is deprecated.', ...loc(attr) })
    },
  },
  {
    name: 'vue/no-deprecated-html-element-is',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT
        || !(isHTMLTag(node.tag) || isSVGTag(node.tag) || isMathMLTag(node.tag))) return
      const attr = findAttr(node, 'is')
      if (attr && !attr.value?.content.startsWith('vue:')) report({
        message: 'The is attribute on native elements is deprecated.', ...loc(attr),
      })
      for (const dir of node.props) if (dir.type === NodeTypes.DIRECTIVE
        && dir.name === 'bind' && argContent(dir) === 'is') report({
        message: 'The is binding on native elements is deprecated.', ...loc(dir),
      })
    },
  },
  {
    name: 'vue/no-deprecated-router-link-tag-prop',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const configured = Array.isArray(options.components)
        ? options.components.filter((name): name is string => typeof name === 'string')
        : ['RouterLink']
      const names = new Set(configured.flatMap((name) => {
        const kebab = kebabComponentName(name)
        const pascal = pascalComponentName(name)
        return [kebab, pascal]
      }))
      if (!names.has(node.tag)) return
      const attr = findAttr(node, 'tag')
      if (attr) {
        report({ message: 'The RouterLink tag prop is deprecated.', ...loc(attr) })
        return
      }
      const dir = node.props.find((prop): prop is DirectiveNode =>
        prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && argContent(prop) === 'tag')
      if (dir?.arg) report({ message: 'The RouterLink tag prop is deprecated.', ...loc(dir.arg) })
    },
  },
  {
    name: 'vue/no-deprecated-scope-attribute',
    severity: 'error',
    check(node, report) {
      const attr = findAttr(node, 'scope')
      if (attr) report({ message: 'The scope attribute is deprecated.', ...loc(attr) })
    },
  },
  {
    name: 'vue/no-deprecated-slot-scope-attribute',
    severity: 'error',
    check(node, report) {
      const attr = findAttr(node, 'slot-scope')
      if (attr) report({ message: 'The slot-scope attribute is deprecated.', ...loc(attr) })
    },
  },
  {
    name: 'vue/no-deprecated-slot-attribute',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const attr = findAttr(node, 'slot')
      if (attr) {
        const parentTag = (node as AnnotatedElement).__parentTag
        const ignored = matchesConfiguredName(options.ignore, node.tag)
          || parentTag != null && matchesConfiguredName(options.ignoreParents, parentTag)
        if (!ignored) report({ message: 'The slot attribute is deprecated.', ...loc(attr) })
      }
      for (const dir of node.props) if (dir.type === NodeTypes.DIRECTIVE
        && dir.name === 'bind' && argContent(dir) === 'slot') report({
        message: 'The slot binding is deprecated.', ...loc(dir),
      })
    },
  },
  {
    name: 'vue/no-useless-template-attributes',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || node.tag !== 'template'
        || !(node as AnnotatedElement).__parentTag) return
      const fragmentAttribute = (prop: ElementNode['props'][number]): boolean => {
        if (prop.type === NodeTypes.ATTRIBUTE) return prop.name === 'slot'
        if (['if', 'else', 'else-if', 'for', 'slot', 'slot-scope', 'scope'].includes(prop.name)) return true
        return prop.name === 'bind' && argContent(prop) === 'slot'
      }
      if (!node.props.some(fragmentAttribute)) return
      for (const prop of node.props) {
        if (fragmentAttribute(prop)) continue
        if (prop.type === NodeTypes.ATTRIBUTE && prop.name === 'key') continue
        if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && argContent(prop) === 'key') continue
        report({
          message: prop.type === NodeTypes.DIRECTIVE
            ? 'Unexpected useless directive on <template>.'
            : 'Unexpected useless attribute on <template>.',
          ...loc(prop),
        })
      }
    },
  },
  {
    name: 'vue/valid-template-root',
    severity: 'error',
    // The SFC block wrapper is outside compiler-core's template AST. It is
    // checked once in checkTemplate, where the descriptor is available.
    check() {},
  },
  {
    name: 'vue/require-toggle-inside-transition',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const context = node as AnnotatedElement
      const parent = context.__parentElement
      if (!parent || parent.tag.toLowerCase() !== 'transition' || !context.__firstElementChild) return
      if (customComponent(node) || node.tag === 'slot') return
      if (findAttr(parent, 'appear')) return
      const boundAppear = parent.props.find((prop): prop is DirectiveNode =>
        prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && argContent(prop) === 'appear')
      if (boundAppear) {
        const value = expressionAst(boundAppear.exp)
        if (!value || value.type !== 'BooleanLiteral' || value.value !== false) return
      }
      const additional = Array.isArray(options.additionalDirectives)
        ? options.additionalDirectives.filter((name): name is string => typeof name === 'string') : []
      if (['if', 'show', ...additional].some(name => findDir(node, name)) || hasKeyBinding(node)) return
      report({
        message: 'The element inside <transition> must control whether it is displayed.', ...loc(node),
      })
    },
  },
  {
    name: 'vue/valid-v-bind',
    severity: 'error',
    check(node, report) {
      for (const dir of propsOf(node)) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'bind') continue
        for (const modifier of dir.modifiers) if (!['prop', 'camel', 'sync', 'attr'].includes(modifier.content)) report({
          message: `v-bind does not support the .${modifier.content} modifier.`, ...loc(modifier),
        })
        const sameNameShorthand = dir.arg != null && !dir.loc.source.includes('=')
        if (!sameNameShorthand && !dir.exp?.loc.source) report({
          message: 'v-bind requires a value.', ...loc(dir),
        })
      }
    },
  },
  {
    name: 'vue/valid-v-on',
    severity: 'error',
    check(node, report, options) {
      const custom = new Set(Array.isArray(options.modifiers)
        ? options.modifiers.filter((name): name is string => typeof name === 'string') : [])
      for (const dir of propsOf(node)) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'on') continue
        for (const modifier of dir.modifiers) {
          const name = modifier.content
          const numeric = Number.isSafeInteger(Number.parseInt(name, 10))
          if (!VALID_V_ON_MODIFIERS.has(name) && !numeric
            && [...name].length !== 1 && !custom.has(name)) report({
            message: `v-on does not support the .${name} modifier.`, ...loc(modifier),
          })
        }
        if (dir.modifiers.some(modifier => ['stop', 'prevent'].includes(modifier.content))) continue
        const raw = dir.exp?.loc.source ?? ''
        const expression = expressionAst(dir.exp)
        if (!raw) report({ message: 'v-on requires a value or stop/prevent modifier.', ...loc(dir) })
        else if (!expression && /^\w+$/u.test(raw)) report({
          message: `Avoid the JavaScript keyword ${raw} as a v-on value.`, ...directiveValueLoc(dir),
        })
      }
    },
  },
  {
    name: 'vue/valid-attribute-name',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || customComponent(node)) return
      for (const prop of node.props) {
        if (prop.type === NodeTypes.ATTRIBUTE && !validXmlName(prop.name)) report({
          message: `Attribute name ${prop.name} is invalid.`, ...loc(prop),
        })
        if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind'
          && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic
          && !validXmlName(prop.arg.content)) report({
          message: `Attribute name ${prop.arg.content} is invalid.`, ...loc(prop),
        })
      }
    },
  },
  {
    name: 'vue/no-v-text',
    severity: 'warning',
    check(node, report) {
      for (const dir of propsOf(node)) if (dir.type === NodeTypes.DIRECTIVE && dir.name === 'text') report({
        message: 'Do not use v-text.', ...loc(dir),
      })
    },
  },
  {
    name: 'vue/no-use-v-else-with-v-for',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || !findDir(node, 'for')) return
      if (findDir(node, 'else-if') || findDir(node, 'else')) report({
        message: 'Move v-else-if or v-else to a wrapper instead of combining it with v-for.', ...loc(node),
      })
    },
  },
  {
    name: 'vue/no-v-for-template-key',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || node.tag !== 'template' || !findDir(node, 'for')) return
      const key = findAttr(node, 'key') ?? node.props.find((prop): prop is DirectiveNode =>
        prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && argContent(prop) === 'key')
      if (key) report({ message: 'A Vue 2 <template v-for> cannot be keyed.', ...loc(key) })
    },
  },
  {
    name: 'vue/no-v-model-argument',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || !customComponent(node)) return
      for (const dir of node.props) if (dir.type === NodeTypes.DIRECTIVE
        && dir.name === 'model' && dir.arg) report({
        message: 'Vue 2 v-model does not accept an argument.', ...loc(dir),
      })
    },
  },
  {
    name: 'vue/no-custom-modifiers-on-v-model',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || !customComponent(node)) return
      for (const dir of node.props) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'model') continue
        for (const modifier of dir.modifiers) if (!['lazy', 'number', 'trim'].includes(modifier.content)) report({
          message: `v-model does not support the .${modifier.content} modifier.`, ...loc(dir),
        })
      }
    },
  },
  {
    name: 'vue/slot-name-casing',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || node.tag !== 'slot') return
      const attr = findAttr(node, 'name')
      const name = attr?.value?.content
      if (!attr || !name) return
      const mode = typeof options.mode === 'string' ? options.mode : 'camelCase'
      const valid = mode === 'singleword' ? /^[a-z]+$/u.test(name)
        : mode === 'kebab-case' ? /^[a-z][a-z\d]*(?:-[a-z\d]+)*$/u.test(name)
          : /^[a-z][A-Za-z\d]*$/u.test(name)
      if (!valid) report({ message: `Slot name ${name} is not ${mode}.`, ...loc(attr) })
    },
  },
  {
    name: 'vue/no-lone-template',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || node.tag !== 'template') return
      const keyName = (prop: ElementNode['props'][number]): string | undefined =>
        prop.type === NodeTypes.ATTRIBUTE ? prop.name
          : prop.name === 'bind' ? argContent(prop) : undefined
      const structural = node.props.some((prop) => prop.type === NodeTypes.DIRECTIVE
        && ['if', 'else', 'else-if', 'for', 'slot', 'slot-scope', 'scope'].includes(prop.name)
        || ['slot', 'slot-scope', 'scope'].includes(keyName(prop) ?? ''))
      const accessible = options.ignoreAccessible === true
        && node.props.some(prop => ['id', 'ref'].includes(keyName(prop) ?? ''))
      if (!structural && !accessible) report({ message: '<template> requires a structural directive.', ...loc(node) })
    },
  },
  {
    name: 'vue/max-template-depth',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || typeof options.maxDepth !== 'number') return
      const depth = (node as AnnotatedElement).__depth ?? 0
      if (depth > options.maxDepth) report({
        message: `Element depth ${depth} exceeds ${options.maxDepth}.`, ...loc(node),
      })
    },
  },
  {
    name: 'vue/no-root-v-if',
    severity: 'warning',
    check(node, report) {
      if (node.type !== NodeTypes.ROOT) return
      const elements = node.children.filter((child): child is ElementNode => child.type === NodeTypes.ELEMENT)
      const root = elements[0]
      if (elements.length !== 1 || !root || !findDir(root, 'if')) return
      const context = node as RootNode & Annotations
      if (!context.__source || context.__templateContentStart === undefined) return
      const opening = context.__source.slice(0, context.__templateContentStart).lastIndexOf('<template')
      report({ message: 'Do not use v-if on the only root element.', ...sourceLoc(context.__source, Math.max(0, opening)) })
    },
  },
  {
    name: 'vue/html-button-has-type',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || node.tag !== 'button') return
      const attr = findAttr(node, 'type')
      if (attr) {
        const value = attr.value?.content
        if (!value) report({ message: 'A button type value is required.', ...loc(attr.value ?? attr) })
        else if (!['button', 'submit', 'reset'].includes(value)) report({
          message: `${value} is not a valid button type.`, ...loc(attr.value!),
        })
        else if (options[value] === false) report({
          message: `${value} is forbidden by the button type configuration.`, ...loc(attr.value!),
        })
        return
      }
      const bound = node.props.find((prop): prop is DirectiveNode => prop.type === NodeTypes.DIRECTIVE
        && prop.name === 'bind' && argContent(prop) === 'type')
      if (bound) {
        if (!bound.exp?.loc.source) {
          const equals = bound.loc.source.indexOf('=')
          report({
            message: 'A button type value is required.',
            ...(equals < 0 ? loc(bound) : relativeLoc(bound, equals + 1)),
          })
        }
        return
      }
      report({ message: 'Add an explicit type to this button.', ...loc(node) })
    },
  },
  {
    name: 'vue/no-multiple-objects-in-class',
    severity: 'warning',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const binding = node.props.find((prop): prop is DirectiveNode => prop.type === NodeTypes.DIRECTIVE
        && prop.name === 'bind' && argContent(prop) === 'class')
      const expression = expressionAst(binding?.exp)
      if (!binding || expression?.type !== 'ArrayExpression') return
      if (expression.elements.filter(element => element?.type === 'ObjectExpression').length > 1) report({
        message: 'Merge the objects in this class binding.', ...loc(binding),
      })
    },
  },
  {
    name: 'vue/html-end-tags',
    severity: 'warning',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || HTML_VOID_TAGS.has(node.tag) || node.isSelfClosing) return
      const source = node.loc.source
      if (source.includes('<!--') && !source.includes('-->')
        || source.includes('<![CDATA[') && !source.includes(']]>')) return
      const escaped = node.tag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      const tags = source.match(new RegExp(`</?${escaped}(?:\\s[^>]*)?/?>`, 'giu')) ?? []
      const openings = tags.filter(tag => !tag.startsWith('</') && !tag.endsWith('/>')).length
      const closings = tags.filter(tag => tag.startsWith('</')).length
      if (closings < openings) report({
        message: `<${node.tag}> requires an end tag.`, ...loc(node),
      })
    },
  },
  {
    name: 'vue/no-spaces-around-equal-signs-in-attribute',
    severity: 'warning',
    check(node, report) {
      for (const prop of propsOf(node)) {
        const raw = prop.loc.source
        const equals = raw.indexOf('=')
        if (equals < 0) continue
        const keyLength = prop.type === NodeTypes.ATTRIBUTE
          ? prop.name.length : (prop.rawName?.length ?? equals)
        if (raw.slice(keyLength, equals).length || /^=\s/u.test(raw.slice(equals))) report({
          message: 'Remove spaces around the equal sign.', ...relativeLoc(prop, keyLength),
        })
      }
    },
  },
  {
    name: 'vue/v-on-style',
    severity: 'warning',
    check(node, report, options) {
      const longform = options.mode === 'longform'
      for (const dir of propsOf(node)) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'on' || !dir.arg) continue
        const shorthand = dir.loc.source.startsWith('@')
        if (shorthand === !longform) continue
        report({
          message: longform ? 'Use v-on: instead of @.' : 'Use @ instead of v-on:.', ...loc(dir),
        })
      }
    },
  },
  {
    name: 'vue/mustache-interpolation-spacing',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.INTERPOLATION) return
      const raw = node.loc.source
      const inner = raw.slice(2, -2)
      if (!inner.trim()) return
      const always = options.mode !== 'never'
      if (always) {
        if (!/^\s/u.test(inner)) report({ message: "Add a space after '{{'.", ...loc(node) })
        if (!/\s$/u.test(inner)) report({
          message: "Add a space before '}}'.", ...relativeLoc(node, raw.length - 2),
        })
      } else {
        if (/^\s/u.test(inner)) report({ message: "Remove the space after '{{'.", ...loc(node) })
        if (/\s$/u.test(inner)) report({
          message: "Remove the space before '}}'.", ...relativeLoc(node, 2 + inner.trimEnd().length),
        })
      }
    },
  },
  {
    name: 'vue/max-attributes-per-line',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || !node.props.length) return
      const last = node.props.at(-1)!
      const suffixStart = last.loc.end.offset - node.loc.start.offset
      const suffix = node.loc.source.slice(suffixStart)
      const close = suffix.indexOf('>')
      const singleline = node.props.every(prop => prop.loc.start.line === node.loc.start.line
        && prop.loc.end.line === node.loc.start.line)
        && (close < 0 || !suffix.slice(0, close).includes('\n'))
      const limit = numericLimit(singleline ? options.singleline : options.multiline)
      const groups: ElementNode['props'][] = []
      for (const prop of node.props) {
        const group = groups.at(-1)
        if (!group?.length || group.at(-1)!.loc.end.line !== prop.loc.start.line) groups.push([prop])
        else group.push(prop)
      }
      for (const group of singleline ? [node.props] : groups) {
        for (const prop of group.slice(limit)) report({
          message: 'Move this attribute to a new line.', ...loc(prop),
        })
      }
    },
  },
  {
    name: 'vue/first-attribute-linebreak',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const first = node.props[0]
      const last = node.props.at(-1)
      if (!first || !last) return
      const singleline = first.loc.start.line === last.loc.end.line
      const placement = options[singleline ? 'singleline' : 'multiline']
        ?? (singleline ? 'ignore' : 'below')
      if (placement === 'ignore') return
      const beside = node.loc.start.line === first.loc.start.line
      if (placement === 'below' ? beside : placement === 'beside' && !beside) report({
        message: placement === 'below'
          ? 'Move the first attribute to a new line.' : 'Move the first attribute beside the tag name.',
        ...loc(first),
      })
    },
  },
  {
    name: 'vue/html-quotes',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const expected = options.mode === 'single' ? "'" : '"'
      const avoidEscape = options.secondary && typeof options.secondary === 'object'
        && (options.secondary as { avoidEscape?: unknown }).avoidEscape === true
      for (const prop of node.props) {
        const raw = prop.loc.source
        const equals = raw.indexOf('=')
        if (equals < 0) continue
        const value = raw.slice(equals + 1).trimStart()
        if (!value) continue
        const quote = value[0]
        if ((quote === '"' || quote === "'") && !value.endsWith(quote)) continue
        if (quote === expected || avoidEscape && (quote === '"' || quote === "'")
          && value.slice(1, -1).includes(expected)) continue
        const valueOffset = equals + 1 + raw.slice(equals + 1).length - raw.slice(equals + 1).trimStart().length
        report({ message: `Use ${expected === '"' ? 'double' : 'single'} quotes.`, ...relativeLoc(prop, valueOffset) })
      }
    },
  },
  {
    name: 'vue/attribute-hyphenation',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || !customComponent(node) && node.tag !== 'slot') return
      const secondary = options.secondary && typeof options.secondary === 'object'
        ? options.secondary as Record<string, unknown> : {}
      if (configuredNameMatch(node.tag, secondary.ignoreTags)) return
      const hyphenated = options.mode !== 'never'
      for (const prop of node.props) {
        const name = prop.type === NodeTypes.ATTRIBUTE ? prop.name
          : ['bind', 'model'].includes(prop.name) ? argContent(prop) : undefined
        if (!name || configuredNameMatch(name, secondary.ignore)
          || ['data-', 'aria-', 'slot-scope'].some(prefix => name.includes(prefix))) continue
        const invalid = hyphenated ? name.toLowerCase() !== name : name.includes('-')
        if (invalid) report({
          message: hyphenated ? `Attribute ${name} must be hyphenated.` : `Attribute ${name} cannot be hyphenated.`,
          ...loc(prop),
        })
      }
    },
  },
  {
    name: 'vue/v-on-event-hyphenation',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || !customComponent(node)) return
      const secondary = options.secondary && typeof options.secondary === 'object'
        ? options.secondary as Record<string, unknown> : {}
      if (configuredNameMatch(node.tag, secondary.ignoreTags)) return
      const ignored = Array.isArray(secondary.ignore)
        ? secondary.ignore.filter((value): value is string => typeof value === 'string') : []
      const hyphenated = options.mode !== 'never'
      for (const dir of node.props) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'on') continue
        const name = argContent(dir)
        if (!name || ignored.some(value => name.includes(value))) continue
        const invalid = hyphenated ? name.toLowerCase() !== name : name.includes('-')
        if (invalid) report({
          message: hyphenated ? `Event ${name} must be hyphenated.` : `Event ${name} cannot be hyphenated.`,
          ...loc(dir),
        })
      }
    },
  },
  {
    name: 'vue/v-bind-style',
    severity: 'warning',
    check(node, report, options) {
      const secondary = options.secondary && typeof options.secondary === 'object'
        ? options.secondary as Record<string, unknown> : {}
      for (const dir of propsOf(node)) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'bind' || !dir.arg) continue
        const raw = dir.loc.source
        const name = argContent(dir)
        const exp = dir.exp?.loc.source
        const shorthand = !raw.includes('=')
        const sameName = shorthand || Boolean(name && exp && kebabToCamel(name) === kebabToCamel(exp))
        if (secondary.sameNameShorthand !== 'ignore' && sameName) {
          if (secondary.sameNameShorthand === 'always' ? !shorthand
            : secondary.sameNameShorthand === 'never' && shorthand) report({
            message: shorthand ? 'Do not use same-name shorthand.' : 'Use same-name shorthand.', ...loc(dir),
          })
        }
        const shorthandStyle = raw.startsWith(':') || raw.startsWith('.')
        const preferShorthand = options.mode !== 'longform'
        if (shorthandStyle !== preferShorthand) report({
          message: preferShorthand ? 'Use : instead of v-bind:.' : 'Use v-bind: instead of shorthand.', ...loc(dir),
        })
      }
    },
  },
  {
    name: 'vue/restricted-component-names',
    severity: 'error',
    check(node, report, options) {
      if (options.configured !== true || node.type !== NodeTypes.ELEMENT || !customComponent(node)
        || ['component', 'keep-alive', 'suspense', 'teleport', 'transition', 'transition-group'].includes(node.tag)) return
      if (!configuredNameMatch(node.tag, options.allow)) report({
        message: `Component ${node.tag} is not allowed.`, ...loc(node),
      })
    },
  },
  {
    name: 'vue/no-restricted-html-elements',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      for (const item of Array.isArray(options.rawOptions) ? options.rawOptions : []) {
        const value = item && typeof item === 'object' ? (item as { element?: unknown }).element : item
        const names = Array.isArray(value) ? value : [value]
        if (names.includes(node.tag)) {
          report({ message: `Element ${node.tag} is restricted.`, ...loc(node) })
          return
        }
      }
    },
  },
  {
    name: 'vue/no-template-target-blank',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const target = findAttr(node, 'target')
      if (target?.value?.content !== '_blank') return
      const rel = (findAttr(node, 'rel')?.value?.content ?? '').toLowerCase().split(' ')
      if (rel.includes('noopener') && (options.allowReferrer === true || rel.includes('noreferrer'))) return
      const href = findAttr(node, 'href')?.value?.content
      const dynamic = node.props.some(prop => prop.type === NodeTypes.DIRECTIVE
        && prop.name === 'bind' && argContent(prop) === 'href')
      if (!(href && /^(?:\w+:|\/\/)/u.test(href))
        && !(dynamic && options.enforceDynamicLinks !== 'never')) return
      report({ message: 'External target=_blank links require a secure rel.', ...loc(target) })
    },
  },
  {
    name: 'vue/static-class-names-order',
    severity: 'warning',
    check(node, report) {
      const attr = findAttr(node, 'class')
      const value = attr?.value?.content
      if (!attr || value === undefined) return
      const withWhitespace = value.split(/(\s+)/u)
      const divider = withWhitespace.length > 1 ? withWhitespace[1]! : ''
      const sorted = withWhitespace.filter(name => name.trim()).toSorted((a, b) => a.localeCompare(b)).join(divider)
      if (value !== sorted) report({ message: 'Order static class names alphabetically.', ...loc(attr) })
    },
  },
  {
    name: 'vue/v-for-delimiter-style',
    severity: 'warning',
    check(node, report, options) {
      const dir = findDir(node, 'for')
      if (!dir?.exp) return
      const match = dir.exp.loc.source.match(/\s+(in|of)\s+/u)
      const preferred = options.mode === 'of' ? 'of' : 'in'
      if (match?.[1] !== preferred) report({
        message: `Use ${preferred} as the v-for delimiter.`, ...loc(dir.exp),
      })
    },
  },
  {
    name: 'vue/prefer-true-attribute-shorthand',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || !customComponent(node)) return
      const secondary = options.secondary && typeof options.secondary === 'object'
        ? options.secondary as Record<string, unknown> : {}
      const always = options.mode !== 'never'
      for (const prop of node.props) {
        const name = prop.type === NodeTypes.ATTRIBUTE ? prop.name
          : prop.name === 'bind' ? argContent(prop) : undefined
        if (!name) continue
        const excepted = configuredNameMatch(name, secondary.except)
        if (prop.type === NodeTypes.ATTRIBUTE && !prop.value) {
          if (always ? excepted : !excepted) report({ message: 'Write this true prop in long form.', ...loc(prop) })
        } else if (prop.type === NodeTypes.DIRECTIVE) {
          const expression = expressionAst(prop.exp)
          if (expression?.type === 'BooleanLiteral' && expression.value === true
            && (always ? !excepted : excepted)) report({
            message: 'Write this true prop in shorthand form.', ...loc(prop),
          })
        }
      }
    },
  },
  {
    name: 'vue/no-multiple-template-root',
    severity: 'error',
    check(node, report, options) {
      if (options.configured !== true || node.type !== NodeTypes.ROOT) return
      if (options.disallowComments === true) for (const child of node.children) {
        if (child.type === NodeTypes.COMMENT) report({ message: 'Comments are not allowed at the template root.', ...loc(child) })
      }
      const roots: ElementNode[] = []
      let extraElement: ElementNode | undefined
      let extraText: TemplateChildNode | undefined
      let conditional = false
      for (const child of node.children) {
        if (child.type === NodeTypes.ELEMENT) {
          if (!roots.length) { roots.push(child); conditional = Boolean(findDir(child, 'if')) }
          else if (conditional && findDir(child, 'else-if')) roots.push(child)
          else if (conditional && findDir(child, 'else')) { roots.push(child); conditional = false }
          else extraElement = child
        } else if (child.type !== NodeTypes.COMMENT
          && !(child.type === NodeTypes.TEXT && !child.content.trim())) extraText = child
      }
      if (extraText) report({ message: 'The template root must be an element.', ...loc(extraText) })
      else if (extraElement) report({ message: 'The template requires exactly one root element.', ...loc(extraElement) })
      else for (const root of roots) {
        if (root.tag === 'template' || root.tag === 'slot') report({
          message: `<${root.tag}> cannot be the Vue 2 template root.`, ...loc(root),
        })
        if (findDir(root, 'for')) report({ message: 'v-for cannot be used on the Vue 2 template root.', ...loc(root) })
      }
    },
  },
  {
    name: 'vue/no-restricted-v-on',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const restrictions = Array.isArray(options.rawOptions) ? options.rawOptions : []
      for (const dir of node.props) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'on') continue
        if (restrictions.some(item => directiveRestrictionMatches(
          item, argContent(dir), dir.modifiers.map(modifier => modifier.content), node.tag,
        ))) report({ message: 'This v-on usage is restricted.', ...loc(dir) })
      }
    },
  },
  {
    name: 'vue/no-restricted-v-bind',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const configured = Array.isArray(options.rawOptions) ? options.rawOptions : []
      const restrictions = configured.length ? configured : [{ argument: '/^v-/' }]
      for (const dir of node.props) {
        if (dir.type !== NodeTypes.DIRECTIVE || dir.name !== 'bind') continue
        if (restrictions.some(item => directiveRestrictionMatches(
          item, argContent(dir), dir.modifiers.map(modifier => modifier.content), node.tag,
        ))) report({ message: 'This v-bind usage is restricted.', ...loc(dir) })
      }
    },
  },
  {
    name: 'vue/no-restricted-static-attribute',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const restrictions = optionList(options)
      if (!restrictions.length) return
      for (const prop of node.props) {
        if (prop.type !== NodeTypes.ATTRIBUTE) continue
        const value = prop.value?.content
        const matched = restrictions.some(item => {
          if (typeof item === 'string') return patternMatches(prop.name, item)
          if (!item || typeof item !== 'object') return false
          const rule = item as { key?: unknown, value?: unknown, element?: unknown }
          if (!patternMatches(prop.name, rule.key)) return false
          if (rule.value === true && value !== undefined && value !== prop.name) return false
          if (typeof rule.value === 'string' && (value === undefined || !patternMatches(value, rule.value))) return false
          return rule.element === undefined || patternMatches(node.tag, rule.element)
        })
        if (matched) report({ ...loc(prop), message: `Using static attribute '${prop.name}' is not allowed.` })
      }
    },
  },
  {
    name: 'vue/no-restricted-class',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const restrictions = optionList(options)
      if (!restrictions.length) return
      const staticClass = findAttr(node, 'class')
      for (const name of classNames(staticClass?.value?.content ?? '')) {
        if (configuredNameMatch(name, restrictions)) report({ ...loc(staticClass!.value!), message: `'${name}' class is not allowed.` })
      }
      const binding = node.props.find(p => p.type === NodeTypes.DIRECTIVE
        && p.name === 'bind' && argContent(p) === 'class') as DirectiveNode | undefined
      const ast = expressionAst(binding?.exp)
      if (!binding || !ast) return
      for (const value of staticClassValues(ast)) {
        for (const name of classNames(value.value)) {
          if (configuredNameMatch(name, restrictions)) report({ ...classValueLoc(binding.exp!, value.node, ast), message: `'${name}' class is not allowed.` })
        }
      }
    },
  },
  {
    name: 'vue/no-duplicate-class-names',
    severity: 'warning',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const staticNames = new Set<string>()
      const staticClass = findAttr(node, 'class')
      const inspect = (value: string, position: ReturnType<typeof loc>): Set<string> => {
        const local = new Set<string>()
        const duplicates = new Set<string>()
        for (const name of classNames(value)) {
          if (local.has(name)) duplicates.add(name)
          local.add(name)
        }
        if (duplicates.size) report({ ...position, message: `Duplicate class name${duplicates.size > 1 ? 's' : ''} ${[...duplicates].map(name => `'${name}'`).join(', ')}.` })
        return local
      }
      if (staticClass?.value) for (const name of inspect(staticClass.value.content, loc(staticClass.value))) staticNames.add(name)
      const binding = node.props.find(p => p.type === NodeTypes.DIRECTIVE
        && p.name === 'bind' && argContent(p) === 'class') as DirectiveNode | undefined
      const ast = expressionAst(binding?.exp)
      if (!binding || !ast) return
      const collected = new Map<string, ClassFragment>()
      const reported = new Set<string>()
      for (const fragment of classFragments(ast)) {
        const position = classValueLoc(binding.exp!, fragment.node, ast)
        const names = inspect(fragment.value, position)
        const intersection = [...names].filter(name => staticNames.has(name) && !reported.has(name))
        if (intersection.length) {
          report({ ...loc(node), message: `Duplicate class name${intersection.length > 1 ? 's' : ''} ${intersection.map(name => `'${name}'`).join(', ')}.` })
          for (const name of intersection) reported.add(name)
        }
        for (const name of names) {
          const previous = collected.get(name)
          const sameJoinedParent = previous?.parent === fragment.parent
            && (fragment.parent?.type === 'BinaryExpression' || fragment.parent?.type === 'TemplateLiteral')
          if (previous && (previous.unconditional || fragment.unconditional || sameJoinedParent) && !reported.has(name)) {
            report({ ...classValueLoc(binding.exp!, previous.parent ?? previous.node, ast), message: `Duplicate class name '${name}'.` })
            reported.add(name)
          } else if (!previous) collected.set(name, fragment)
        }
      }
    },
  },
  {
    name: 'vue/prefer-separate-static-class',
    severity: 'warning',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const binding = node.props.find(p => p.type === NodeTypes.DIRECTIVE
        && p.name === 'bind' && argContent(p) === 'class') as DirectiveNode | undefined
      const ast = expressionAst(binding?.exp)
      if (!binding || !ast) return
      for (const value of separateStaticClassValues(ast)) {
        const name = value.value.trim().replace(/\s+/gu, ' ')
        if (name) report({ ...classValueLoc(binding.exp!, value.node, ast), message: `Static class "${name}" should be in a static class attribute.` })
      }
    },
  },
  {
    name: 'vue/max-lines-per-block',
    severity: 'warning',
    check() { /* SFC blocks are checked before the template AST walk. */ },
  },
  {
    name: 'vue/no-restricted-block',
    severity: 'warning',
    check() { /* SFC blocks are checked before the template AST walk. */ },
  },
  {
    name: 'vue/no-empty-component-block',
    severity: 'warning',
    check() { /* SFC blocks are checked before the template AST walk. */ },
  },
  {
    name: 'vue/enforce-style-attribute',
    severity: 'warning',
    check() { /* SFC blocks are checked before the template AST walk. */ },
  },
  {
    name: 'vue/block-lang',
    severity: 'warning',
    check() { /* SFC blocks are checked before the template AST walk. */ },
  },
  {
    name: 'vue/padding-line-between-blocks',
    severity: 'warning',
    check() { /* SFC blocks are checked before the template AST walk. */ },
  },
  {
    name: 'vue/block-order',
    severity: 'warning',
    check() { /* SFC blocks are checked before the template AST walk. */ },
  },
  {
    name: 'vue/block-tag-newline',
    severity: 'warning',
    check() { /* SFC blocks are checked before the template AST walk. */ },
  },
  {
    name: 'vue/no-negated-v-if-condition',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || options.configured !== true) return
      const directive = findDir(node, 'if')
      const ast = expressionAst(directive?.exp)
      const negated = ast?.type === 'UnaryExpression' && ast.operator === '!'
        || ast?.type === 'BinaryExpression' && (ast.operator === '!=' || ast.operator === '!==')
      const next = (node as AnnotatedElement).__nextElement
      const hasElse = Boolean(next && findDir(next, 'else'))
      if (directive && negated && hasElse) {
        report({ ...loc(directive.exp!), message: 'Unexpected negated condition in v-if.' })
      }
    },
  },
  {
    name: 'vue/no-literals-in-template',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || options.configured !== true) return
      const ignores = Array.isArray(options.ignores) ? options.ignores : []
      for (const directive of node.props) {
        if (directive.type !== NodeTypes.DIRECTIVE || directive.name !== 'bind') continue
        const argument = argContent(directive)
        if (argument === 'class' || argument === 'style' || argument && configuredNameMatch(argument, ignores)) continue
        const ast = expressionAst(directive.exp)
        if (ast && ['ObjectExpression', 'ArrayExpression', 'FunctionExpression', 'ArrowFunctionExpression'].includes(ast.type)) {
          report({ ...loc(directive.exp!), message: `Unexpected ${ast.type.replace('Expression', '').toLowerCase()} literal in template.` })
        }
      }
    },
  },
  {
    name: 'vue/html-closing-bracket-spacing',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const source = node.loc.source
      const openingEnd = source.indexOf('>')
      if (openingEnd < 0) return
      const selfClosing = source[openingEnd - 1] === '/'
      const bracketStart = selfClosing ? openingEnd - 1 : openingEnd
      const previous = source[bracketStart - 1] ?? ''
      if (source.slice(0, bracketStart).match(/\s*$/u)?.[0].includes('\n')) return
      const mode = selfClosing ? options.selfClosingTag ?? 'always' : options.startTag ?? 'never'
      if ((mode === 'always' && !/\s/u.test(previous)) || (mode === 'never' && /\s/u.test(previous))) {
        report({ ...relativeLoc(node, mode === 'never' ? bracketStart - 1 : bracketStart), message: 'Unexpected spacing before the closing bracket.' })
      }
    },
  },
  {
    name: 'vue/html-closing-bracket-newline',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const source = node.loc.source
      const openingEnd = source.indexOf('>')
      if (openingEnd < 0) return
      const selfClosing = source[openingEnd - 1] === '/'
      const bracketStart = selfClosing ? openingEnd - 1 : openingEnd
      const before = source.slice(0, bracketStart)
      const multiline = before.includes('\n')
      const selfOptions = options.selfClosingTag && typeof options.selfClosingTag === 'object'
        ? options.selfClosingTag as Record<string, unknown> : {}
      const mode = selfClosing && typeof selfOptions[multiline ? 'multiline' : 'singleline'] === 'string'
        ? selfOptions[multiline ? 'multiline' : 'singleline']
        : options[multiline ? 'multiline' : 'singleline'] ?? (multiline ? 'always' : 'never')
      const newlineBefore = /\n\s*$/u.test(before)
      if ((mode === 'always' && !newlineBefore) || (mode === 'never' && newlineBefore)) {
        report({ ...relativeLoc(node, bracketStart), message: 'Unexpected line break before the closing bracket.' })
      }
    },
  },
  {
    name: 'vue/require-v-for-key',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const vFor = findDir(node, 'for')
      if (!vFor) return
      const checkKey = (element: ElementNode): void => {
        if (element.props.some(p => p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && argContent(p) === 'key')) return
        if (element.tag === 'template' || element.tag === 'slot') {
          for (const child of element.children) if (child.type === NodeTypes.ELEMENT) checkKey(child)
        } else if (!customComponent(element)) report({
          ...loc(element),
          message: `<${element.tag}> with 'v-for' must have a ':key'.`,
          help: 'Add a unique :key binding to help Vue track each item.',
        })
      }
      checkKey(node)
    },
  },
  {
    name: 'vue/no-v-for-template-key-on-child',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || node.tag !== 'template' || !findDir(node, 'for')) return
      const loop = findDir(node, 'for')?.forParseResult
      const names = new Set([loop?.value, loop?.key, loop?.index].flatMap(bindingNames))
      const key = node.props.find((p): p is DirectiveNode => p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && argContent(p) === 'key')
      if (key && referencesAny(key.exp, names)) return
      for (const child of node.children) {
        if (child.type !== NodeTypes.ELEMENT || ['for', 'if', 'else-if', 'else'].some(name => findDir(child, name))) continue
        const childKey = child.props.find((p): p is DirectiveNode => p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && argContent(p) === 'key')
        if (!childKey || !referencesAny(childKey.exp, names)) continue
        report({
          ...loc(childKey),
          message: "Place the v-for key on <template>, not its child.",
          help: 'The key identifies the whole iteration fragment in Vue 3.',
        })
      }
    },
  },
  {
    name: 'vue/valid-v-model',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const context = node as AnnotatedElement
      for (const prop of node.props) {
        if (prop.type !== NodeTypes.DIRECTIVE || prop.name !== 'model') continue
        const emit = (problem: string, position = loc(prop)): void => report({
          ...position, message: `v-model ${problem}.`,
          help: 'Bind a writable state variable or property on an input, textarea, select, or component.',
        })
        const native = !customComponent(node)
        if ((native && !['input', 'textarea', 'select'].includes(node.tag))
          || ['slot', 'keep-alive', 'transition', 'transition-group'].includes(node.tag)) emit(`is not supported on <${node.tag}>`)
        if (node.tag === 'input' && findAttr(node, 'type')?.value?.content === 'file') emit('cannot write to a file input')
        if (native && prop.arg) emit('cannot have an argument on a native element', loc(prop.arg))
        if (native) for (const modifier of prop.modifiers) {
          if (!['lazy', 'trim', 'number'].includes(modifier.content)) emit('has an unsupported modifier on a native element', loc(modifier))
        }
        if (!expContent(prop.exp)?.trim()) { emit('requires a writable expression'); continue }
        const raw = expressionAst(prop.exp)
        // Syntax errors belong to no-parsing-error, not this rule.
        if (!raw || raw.type === 'Program') continue
        const target = unwrap(raw)
        const position = astLoc(prop.exp!, raw, raw)
        if (target.type !== 'Identifier' && target.type !== 'MemberExpression') emit('requires an assignable variable or member expression', position)
        else if (hasOptionalReceiver(target)) emit('cannot assign through optional or null receivers', position)
        if (target.type === 'Identifier' && context.__locals?.has(target.name)) emit('cannot assign directly to a loop or slot variable', astLoc(prop.exp!, target, raw))
      }
    },
  },
  {
    name: 'vue/no-v-html',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const dir = findDir(node, 'html')
      if (!dir) return
      if (typeof options.ignorePattern === 'string' && new RegExp(options.ignorePattern).test(expContent(dir.exp) ?? '')) return
      report({
        ...loc(dir),
        message: `'v-html' directive can lead to XSS attacks.`,
        help: 'Prefer interpolation, or sanitise the value before binding it.',
      })
    },
  },
  {
    name: 'vue/no-use-v-if-with-v-for',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const vFor = findDir(node, 'for')
      const vIf = findDir(node, 'if')
      if (!vFor || !vIf) return
      const loop = vFor.forParseResult
      if (options.allowUsingIterationVar && referencesAny(vIf.exp, new Set([loop?.value, loop?.key, loop?.index].flatMap(bindingNames)))) return
      report({
        ...loc(vIf),
        message: `'v-if' should not be used together with 'v-for' on <${node.tag}>.`,
        help: 'Move v-if to a wrapper <template>, or filter the list first.',
      })
    },
  },
  {
    name: 'vue/no-template-key',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || node.tag !== 'template') return
      // Vue 3 structural templates carry fragment/branch identity.
      if (['for', 'if', 'else-if', 'else'].some(name => findDir(node, name))) return
      if (!hasKeyBinding(node)) return
      report({
        ...loc(findAttr(node, 'key') ?? propsOf(node).find(p => p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && argContent(p) === 'key')!),
        message: `'<template>' cannot be keyed.`,
        help: 'Place the key on a real element instead.',
      })
    },
  },
  {
    name: 'vue/no-useless-mustaches',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.INTERPOLATION) return
      const c = node.content
      if (!c || c.type !== NodeTypes.SIMPLE_EXPRESSION) return
      if (!stringLiteral(c, options)) return
      report({
        ...loc(node),
        message: 'Unnecessary mustache interpolation around a literal.',
        help: 'Replace it with the literal text.',
      })
    },
  },
  {
    name: 'vue/no-duplicate-attributes',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const seen = new Map<string, AttributeNode | DirectiveNode>()
      for (const p of node.props) {
        // `:foo` and `foo` collide; `class`/`style` legitimately merge.
        const name = p.type === NodeTypes.DIRECTIVE
          ? (p.name === 'bind' && argContent(p)) || null
          : p.name
        if (!name) continue
        const coexist = name === 'class' && options.allowCoexistClass !== false
          || name === 'style' && options.allowCoexistStyle !== false
        const identity = coexist ? `${name}:${p.type}` : name
        if (seen.has(identity)) {
          report({
            ...loc(p),
            message: `Duplicate attribute '${name}'.`,
            help: 'Remove the duplicate binding.',
          })
          continue
        }
        seen.set(identity, p)
      }
    },
  },
  {
    name: 'vue/require-component-is',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || node.tag !== 'component') return
      const hasIs = node.props.some(p =>
        (p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && argContent(p) === 'is'))
      if (hasIs) return
      report({
        ...loc(node),
        message: `'<component>' requires an 'is' attribute.`,
        help: 'Add :is="..." naming the component to render.',
      })
    },
  },
  {
    name: 'vue/no-v-text-v-html-on-component',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT || !customComponent(node, options.ignoreElementNamespaces === true)) return
      if (Array.isArray(options.allow) && options.allow.some(name => typeof name === 'string' && normalizeComponentName(name) === normalizeComponentName(node.tag))) return
      for (const name of ['html', 'text']) {
        const dir = findDir(node, name)
        if (!dir) continue
        report({
          ...loc(dir),
          message: `'v-${name}' on a component overwrites its own content.`,
          help: 'Pass the value as a prop or slot instead.',
        })
      }
    },
  },
  {
    name: 'vue/valid-v-for',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const dir = findDir(node, 'for')
      if (!dir) return
      const emit = (message: string, position = loc(dir)): void => report({ ...position, message })
      const loop = dir.forParseResult
      const names = new Set([loop?.value, loop?.key, loop?.index].flatMap(bindingNames))
      const checkKey = (element: ElementNode): void => {
        const key = element.props.find((p): p is DirectiveNode => p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && argContent(p) === 'key')
        if (!key && element.tag === 'template') {
          for (const child of element.children) {
            if (child.type !== NodeTypes.ELEMENT) continue
            const childFor = findDir(child, 'for')
            if (childFor && referencesAny(childFor.forParseResult?.source, names)) continue
            checkKey(child)
          }
          return
        }
        if (!key && customComponent(element)) emit('Custom elements in iteration require a :key.', loc(element))
        if (key && !referencesAny(key.exp, names)) emit('The key must use a variable defined by v-for.', loc(key))
      }
      checkKey(node)
      if (dir.arg) emit('v-for cannot have an argument.', loc(dir.arg))
      if (dir.modifiers[0]) emit('v-for cannot have modifiers.', loc(dir.modifiers[0]))
      const content = expContent(dir.exp)
      if (!content?.trim()) { emit('v-for requires a value.'); return }
      if (!loop?.source) {
        if (expressionAst(dir.exp)?.type === 'Identifier') emit('v-for requires the form "item in items".', relativeLoc(dir.exp!, -1))
        return // Invalid JavaScript belongs to no-parsing-error.
      }
      const delimiter = /\s+(?:in|of)\s+/.exec(content)
      if (!delimiter) return
      let lhs = content.slice(0, delimiter.index).trim()
      let start = content.indexOf(lhs)
      if (lhs.startsWith('(') && lhs.endsWith(')')) { lhs = lhs.slice(1, -1); start++ }
      const aliases = expressionAst({ ...dir.exp!, type: NodeTypes.SIMPLE_EXPRESSION, isStatic: false, constType: 0, content: `[${lhs}]` })
      if (aliases?.type !== 'ArrayExpression') return
      aliases.elements.forEach((alias, index) => {
        if (!alias && options.allowEmptyAlias !== true) emit('Invalid empty v-for alias.', loc(dir.exp!))
        else if (alias && index > 0 && alias.type !== 'Identifier') {
          emit('The key and index aliases must be identifiers.', relativeLoc(dir.exp!, start + (alias.start ?? 2) - 2))
        }
      })
    },
  },
  {
    name: 'vue/no-useless-v-bind',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      for (const p of node.props) {
        if (p.type !== NodeTypes.DIRECTIVE || p.name !== 'bind' || !p.arg || p.modifiers.length) continue
        const exp = p.exp
        if (!exp || exp.type !== NodeTypes.SIMPLE_EXPRESSION || exp.isStatic) continue
        if (!stringLiteral(exp, options)) continue
        report({
          ...loc(p),
          message: 'v-bind with a string literal is redundant.',
          help: 'Use a plain static attribute instead.',
        })
      }
    },
  },
  {
    name: 'vue/this-in-template',
    severity: 'error',
    check(node, report, options) {
      const expressions: NonNullable<DirectiveNode['exp']>[] = []
      if (node.type === NodeTypes.INTERPOLATION) expressions.push(node.content)
      if (node.type === NodeTypes.ELEMENT) for (const prop of node.props) {
        if (prop.type !== NodeTypes.DIRECTIVE) continue
        if (prop.name === 'for') {
          if (prop.forParseResult) expressions.push(prop.forParseResult.source)
        } else if (prop.name !== 'slot' && prop.exp) expressions.push(prop.exp)
        if (options.mode !== 'always' && prop.arg && prop.arg.type === NodeTypes.SIMPLE_EXPRESSION && !prop.arg.isStatic) expressions.push(prop.arg)
      }
      const locals = (node as AnyNode & Annotations).__locals
      for (const exp of expressions) {
        const ast = expressionAst(exp)
        if (!ast) continue
        if (options.mode === 'always') {
          walkIdentifiers(ast, id => {
            if (locals?.has(id.name) || id.name === '$event') return
            report({ ...astLoc(exp, id, ast), message: "Expected 'this'." })
          })
        } else visitExpression(ast, member => {
          if (member.type !== 'MemberExpression' && member.type !== 'OptionalMemberExpression') return
          if (member.object.type !== 'ThisExpression') return
          const name = member.computed ? member.property.type === 'StringLiteral' ? member.property.value : null : staticName(member.property)
          if (!name || locals?.has(name) || !/^[$A-Z_a-z][$\w]*$/.test(name)) return
          // Removing this must leave a legal standalone identifier.
          const parsed = expressionAst({ type: NodeTypes.SIMPLE_EXPRESSION, content: name, isStatic: false, constType: 0, loc: exp.loc })
          if (parsed?.type !== 'Identifier' || ['eval', 'arguments', 'let', 'await', 'yield'].includes(name)) return
          report({ ...astLoc(exp, member.object, ast), message: "Unexpected usage of 'this' in a template.", help: 'Template expressions resolve against the instance already.' })
        })
      }
    },
  },
  {
    name: 'vue/require-v-for-with-index-key',
    severity: 'warning',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const vFor = findDir(node, 'for')
      if (!vFor?.forParseResult) return
      const r = vFor.forParseResult
      const source = expressionAst(r.source)
      const context = node as AnnotatedElement
      const knownArray = source?.type === 'ArrayExpression'
        || source?.type === 'NumericLiteral' || source?.type === 'StringLiteral'
        || (source?.type === 'Identifier' && context.__script?.arrays.has(source.name)
          && !context.__outerLocals?.has(source.name))
      // The third alias is an object iteration index. The second alias can
      // be an object property name; warn only for a known array/range/string.
      const indexName = expContent(r.index) ?? (knownArray ? expContent(r.key) : undefined)
      if (!indexName) return

      const keyDir = node.props.find((p): p is DirectiveNode =>
        p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && argContent(p) === 'key')
      if (!keyDir?.exp) return
      // `:key="i"` on a reorderable list defeats Vue's DOM reuse.
      if (String(expContent(keyDir.exp)).trim() !== indexName) return
      report({
        ...loc(keyDir),
        message: `Using the v-for index as ':key' can cause incorrect updates.`,
        help: 'Prefer a stable, unique id from the item itself.',
      })
    },
  },
  {
    name: 'vue/no-static-inline-styles',
    severity: 'warning',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      const emit = (position: ReturnType<typeof loc>): void => report({
        ...position, message: 'Static inline styles are hard to override and reuse.',
        help: 'Move the declarations into a class.',
      })
      for (const prop of node.props) {
        if (prop.type === NodeTypes.ATTRIBUTE) {
          if (prop.name === 'style') emit(loc(prop))
          continue
        }
        if (options.allowBinding || prop.name !== 'bind' || argContent(prop) !== 'style' || !prop.exp) continue
        const ast = expressionAst(prop.exp)
        const elements = ast?.type === 'ObjectExpression' ? [ast] : ast?.type === 'ArrayExpression' ? ast.elements : null
        if (!ast || !elements) continue
        const properties: import('./ast.js').AstNode[] = []
        let allStatic = true
        outer: for (const element of elements) {
          if (!element) continue
          if (element.type !== 'ObjectExpression') { allStatic = false; break }
          let objectStatic = true
          for (const member of element.properties) {
            if (member.type === 'SpreadElement' || member.computed) { allStatic = false; break outer }
            if (member.type === 'ObjectProperty' && ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'RegExpLiteral', 'BigIntLiteral'].includes(member.value.type)) properties.push(member)
            else objectStatic = false
          }
          if (!objectStatic) { allStatic = false; break }
        }
        if (allStatic) emit(loc(prop))
        else for (const member of properties) emit(astLoc(prop.exp, member, ast))
      }
    },
  },
  {
    name: 'vue/no-dupe-v-else-if',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || !findDir(node, 'if')) return
      const previous: Ast[] = []
      const first = expressionAst(findDir(node, 'if')?.exp)
      if (first && first.type !== 'Program') previous.push(first)
      for (const sibling of (node as AnnotatedElement).__siblings ?? []) {
        const exp = findDir(sibling, 'else-if')?.exp
        const ast = expressionAst(exp)
        if (!exp || !ast || ast.type === 'Program') continue
        // Keep OR terms as conjunctions, without distributing nested terms:
        // this matches upstream's bounded comparison and avoids exponential DNF.
        const candidates = (ast.type === 'LogicalExpression' && ast.operator === '&&'
          ? [...splitConditions(ast, '&&'), ast] : [ast]).map(part => ({ part, terms: splitConditions(part, '||').map(term => splitConditions(term, '&&')) }))
        let covered: Ast | undefined
        for (const earlier of previous.toReversed()) {
          const terms = splitConditions(earlier, '||').map(term => splitConditions(term, '&&'))
          for (const candidate of candidates) {
            candidate.terms = candidate.terms.filter(term => !terms.some(prior => prior.every(a => term.some(b => equalConditions(a, b)))))
            if (!candidate.terms.length) { covered = candidate.part; break }
          }
          if (covered) break
        }
        if (covered) report({
          ...astLoc(exp, covered, ast),
          message: 'This branch can never execute: its condition is covered by earlier branches.',
          help: 'Remove the unreachable branch or fix its condition.',
        })
        previous.push(ast)
      }
    },
  },
  {
    name: 'vue/no-mutating-props',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT && node.type !== NodeTypes.INTERPOLATION) return
      const context = node as AnnotatedElement
      const script = context.__script
      if (!script || (!script.props.size && !script.propObjects.size && !script.instanceProps.size)) return
      const expressions = node.type === NodeTypes.INTERPOLATION
        ? [{ exp: node.content, name: '', loc: node.loc }]
        : node.props.filter((prop): prop is DirectiveNode => prop.type === NodeTypes.DIRECTIVE)
      for (const prop of expressions) {
        const ast = expressionAst(prop.exp)
        if (!ast) continue
        const locals = prop.name === 'if' ? context.__outerLocals : context.__locals
        const model = prop.name === 'model' || prop.name === 'bind' && 'modifiers' in prop && prop.modifiers.some(mod => mod.content === 'sync')
        for (const mutation of templatePropMutations(ast, script, locals, options.shallowOnly === true, model)) {
          report({
            ...astLoc(prop.exp!, mutation.node, ast),
            message: `Unexpected mutation of prop '${mutation.name}'.`,
            help: 'Props are read-only; emit an event or use a local copy.',
          })
        }
      }
    },
  },
  {
    name: 'vue/no-textarea-mustache',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || node.tag !== 'textarea') return
      const interp = node.children.filter(
        (c): c is InterpolationNode => c.type === NodeTypes.INTERPOLATION,
      )
      for (const child of interp) report({
        ...loc(child),
        message: 'Interpolation inside <textarea> is not rendered.',
        help: 'Use v-model or :value instead.',
      })
    },
  },
  {
    name: 'vue/no-child-content',
    severity: 'error',
    check(node, report, options) {
      if (node.type !== NodeTypes.ELEMENT) return
      for (const name of ['html', 'text', ...(Array.isArray(options.additionalDirectives) ? options.additionalDirectives.filter((x): x is string => typeof x === 'string') : [])]) {
        const dir = findDir(node, name)
        if (!dir) continue
        // Whitespace-only children are not real content.
        const hasContent = node.children.some(c =>
          (c.type === NodeTypes.TEXT && c.content.trim())
          || c.type === NodeTypes.ELEMENT
          || c.type === NodeTypes.INTERPOLATION || c.type === NodeTypes.COMMENT)
        if (!hasContent) continue
        report({
          ...relativeLoc(node, node.loc.source.indexOf('>', (node.props.at(-1)?.loc.end.offset ?? node.loc.start.offset) - node.loc.start.offset) + 1),
          message: `'v-${name}' will overwrite the element's own content.`,
          help: 'Remove the child content, or drop the directive.',
        })
      }
    },
  },
  {
    name: 'vue/no-target-blank',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const target = findAttr(node, 'target')
      if (target?.value?.content !== '_blank') return
      const rel = findAttr(node, 'rel')?.value?.content || ''
      if (/\bnoopener\b/.test(rel)) return
      report({
        ...loc(target),
        message: `target="_blank" without rel="noopener" is a security risk.`,
        help: 'Add rel="noopener noreferrer".',
      })
    },
  },
]

/**
 * The `content` of an expression node, when it is a simple expression.
 * Compound expressions carry an array of parts instead and are never what
 * these rules compare against.
 */
function expContent(
  exp: SimpleExpressionNode | DirectiveNode['exp'] | undefined,
): string | undefined {
  if (!exp || exp.type !== NodeTypes.SIMPLE_EXPRESSION) return undefined
  return exp.content
}

/**
 * Resolve per-rule severity from an oxlint-style `rules` map.
 *
 * Accepts the same spellings oxlint does -- "off"/"warn"/"error", 0/1/2, and
 * `["warn", ...]` -- so a single `.oxlintrc.json` configures both halves of the
 * tool and users do not have to learn a second syntax.
 */
function severityFor(
  rule: Rule,
  config: RulesMap | undefined,
): 'error' | 'warning' | null {
  const raw: RuleConfig | undefined = config?.[rule.name]
  if (raw === undefined) return rule.severity

  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === 'off' || value === 0 || value === false) return null
  if (value === 'warn' || value === 'warning' || value === 1) return 'warning'
  if (value === 'error' || value === 'deny' || value === 2) return 'error'
  return rule.severity
}

export function checkTemplate(
  ast: RootNode | undefined,
  filename: string,
  source: string,
  config: RulesMap | undefined,
  scriptContent: string | undefined,
): Diagnostic[] {
  const out: Diagnostic[] = []
  const active = RULES
    .map(rule => ({ rule, severity: severityFor(rule, config) }))
    .filter((r): r is { rule: Rule, severity: 'error' | 'warning' } =>
      r.severity !== null)

  // Some rules need context the node itself does not carry: the v-else-if
  // chain a node starts, and which identifiers are props. Attached once here
  // rather than recomputed per rule per node.
  const descriptor = parse(source, { filename }).descriptor
  if (ast) {
    const context = ast as RootNode & Annotations
    context.__source = source
    if (descriptor.template) context.__templateContentStart = descriptor.template.loc.start.offset
  }
  const script = analyzeScript(descriptor.scriptSetup?.content ?? (descriptor.script ? undefined : scriptContent))
  const templateScriptNames = new Set([...script.bindings, ...script.props.keys(),
    ...script.instanceProps, ...componentPublicNames(descriptor)])
  const explicitEmitsRule = active.find(entry => entry.rule.name === 'vue/require-explicit-emits')
  const emitInfo = explicitEmitsRule
    ? explicitEmitInfo(descriptor, ruleOptions(config?.[explicitEmitsRule.rule.name]).allowProps === true)
    : undefined
  if (emitInfo && /<script\b[^>]*\bsetup(?:\s|>|=)/iu.test(source)) emitInfo.hasDefinition = true
  if (explicitEmitsRule && emitInfo) for (const finding of emitInfo.findings) out.push({ filename,
    rule: explicitEmitsRule.rule.name, severity: explicitEmitsRule.severity,
    ...sourceLoc(source, finding.offset),
    message: `The "${finding.name}" event has been triggered but not declared.` } as Diagnostic)
  const componentFileRule = active.find(entry => entry.rule.name === 'vue/one-component-per-file')
  if (componentFileRule) for (const offset of componentDefinitionOffsets(descriptor, source, filename)) {
    out.push({ filename, rule: componentFileRule.rule.name, severity: componentFileRule.severity,
      ...sourceLoc(source, offset), message: 'There is more than one component in this file.' } as Diagnostic)
  }
  const componentOrderRule = active.find(entry => entry.rule.name === 'vue/order-in-components')
  if (componentOrderRule) {
    const options = ruleOptions(config?.[componentOrderRule.rule.name])
    for (const finding of componentOrderFindings(descriptor, source, options.order)) {
      out.push({ filename, rule: componentOrderRule.rule.name, severity: componentOrderRule.severity,
        ...sourceLoc(source, finding.offset),
        message: `The "${finding.name}" property is out of order.` } as Diagnostic)
    }
  }
  const computedRule = active.find(entry => entry.rule.name === 'vue/no-use-computed-property-like-method')
  const computedInfo = computedRule ? computedPropertyInfo(descriptor) : { names: new Set<string>(), findings: [] }
  if (computedRule) for (const finding of computedInfo.findings) out.push({ filename,
    rule: computedRule.rule.name, severity: computedRule.severity, ...sourceLoc(source, finding.offset),
    message: 'Use the computed property without calling it.' } as Diagnostic)
  const refOperandRule = active.find(entry => entry.rule.name === 'vue/no-ref-as-operand')
  if (refOperandRule) for (const finding of refOperandFindings(descriptor, source,
    ruleOptions(config?.[refOperandRule.rule.name]).globalRef === true)) {
    out.push({ filename, rule: refOperandRule.rule.name, severity: refOperandRule.severity,
      ...sourceLoc(source, finding.offset),
      message: `Must use \`.value\` to read or write the value wrapped by \`${finding.method}()\`.` } as Diagnostic)
  }
  const validDefaultRule = active.find(entry => entry.rule.name === 'vue/require-valid-default-prop')
  if (validDefaultRule) for (const finding of validDefaultPropFindings(descriptor, source)) {
    out.push({ filename, rule: validDefaultRule.rule.name, severity: validDefaultRule.severity,
      ...sourceLoc(source, finding.offset), message: 'Type of the default prop value is invalid.' } as Diagnostic)
  }
  const componentNameRule = active.find(entry => entry.rule.name === 'vue/multi-word-component-names')
  if (componentNameRule) {
    const options = ruleOptions(config?.[componentNameRule.rule.name])
    for (const finding of componentNameFindings(descriptor, filename, options.ignores)) {
      out.push({ filename, rule: componentNameRule.rule.name, severity: componentNameRule.severity,
        ...sourceLoc(source, finding.offset),
        message: `Component name "${finding.name}" should always be multi-word.` } as Diagnostic)
    }
  }
  const unusedComponentsRule = active.find(entry => entry.rule.name === 'vue/no-unused-components')
  if (unusedComponentsRule && ast && descriptor.template && !Object.hasOwn(descriptor.template.attrs, 'src')) {
    const used = new Set<string>()
    let dynamicBinding = false
    const collect = (node: AnyNode): void => {
      if (node.type === NodeTypes.ELEMENT) {
        if (customComponent(node)) used.add(node.tag)
        const staticIs = findAttr(node, 'is')?.value?.content
        if (staticIs) used.add(staticIs.startsWith('vue:') ? staticIs.slice(4) : staticIs)
        for (const dir of node.props) {
          if (dir.type !== NodeTypes.DIRECTIVE
            || !(dir.name === 'is' || dir.name === 'bind' && argContent(dir) === 'is') || !dir.exp) continue
          const value = expressionAst(dir.exp)
          if (value?.type === 'StringLiteral') used.add(value.value)
          else if (value) dynamicBinding = true
        }
      }
      for (const child of childrenOf(node)) collect(child)
    }
    collect(ast)
    const options = ruleOptions(config?.[unusedComponentsRule.rule.name])
    if (!dynamicBinding || options.ignoreWhenBindingPresent === false) {
      for (const component of registeredComponents(descriptor)) {
        const pascal = pascalComponentName(component.name)
        const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1)
        const flexible = /^[A-Z][\dA-Za-z]*$/u.test(component.name)
          || /^[a-z][\dA-Za-z]*$/u.test(component.name)
        const found = flexible
          ? [...used].some(name => !name.includes('_')
            && (pascalComponentName(name) === pascal || (pascalComponentName(name).charAt(0).toLowerCase()
              + pascalComponentName(name).slice(1)) === camel))
          : used.has(component.name)
        if (!found) out.push({ filename, rule: unusedComponentsRule.rule.name,
          severity: unusedComponentsRule.severity, ...sourceLoc(source, component.offset),
          message: `The "${component.name}" component has been registered but not used.` } as Diagnostic)
      }
    }
  }
  const deprecatedNames = new Map([
    ['$listeners', 'vue/no-deprecated-dollar-listeners-api'],
    ['$scopedSlots', 'vue/no-deprecated-dollar-scopedslots-api'],
  ])
  for (const finding of scriptInstanceMembers(descriptor, new Set(deprecatedNames.keys()))) {
    const ruleName = deprecatedNames.get(finding.name)!
    const entry = active.find(item => item.rule.name === ruleName)
    if (!entry) continue
    out.push({ filename, rule: ruleName, severity: entry.severity,
      ...sourceLoc(source, finding.offset), message: `The ${finding.name} instance property is deprecated.` } as Diagnostic)
  }
  const blocks = [descriptor.template, descriptor.script, descriptor.scriptSetup, ...descriptor.styles, ...descriptor.customBlocks]
    .filter(block => block !== null)
  const maxLinesRule = active.find(entry => entry.rule.name === 'vue/max-lines-per-block')
  if (maxLinesRule) {
    const options = ruleOptions(config?.[maxLinesRule.rule.name])
    if (options.configured) for (const block of blocks) {
      const limit = typeof options[block.type] === 'number' ? options[block.type] as number : undefined
      if (limit === undefined) continue
      let lines = block.loc.end.line - block.loc.start.line - 1
      if (options.skipBlankLines === true) lines -= block.content.split('\n').slice(1, -1).filter(line => !line.trim()).length
      if (lines > limit) {
        const opening = source.slice(0, block.loc.start.offset).lastIndexOf(`<${block.type}`)
        out.push({ filename, rule: maxLinesRule.rule.name, severity: maxLinesRule.severity,
          ...sourceLoc(source, Math.max(0, opening)),
          message: `Block has too many lines (${lines}). Maximum allowed is ${limit}.` } as Diagnostic)
      }
    }
  }
  const restrictedBlockRule = active.find(entry => entry.rule.name === 'vue/no-restricted-block')
  if (restrictedBlockRule) {
    const options = ruleOptions(config?.[restrictedBlockRule.rule.name])
    if (options.configured) {
      for (const block of topLevelBlockTags(source)) {
        const item = optionList(options).find(candidate => patternMatches(block.type,
        typeof candidate === 'string' ? candidate
          : candidate && typeof candidate === 'object' ? (candidate as { element?: unknown }).element : undefined))
        if (item !== undefined) {
          const message = item && typeof item === 'object' && typeof (item as { message?: unknown }).message === 'string'
            ? (item as { message: string }).message : `Using <${block.type}> is not allowed.`
          out.push({ filename, rule: restrictedBlockRule.rule.name, severity: restrictedBlockRule.severity,
            ...sourceLoc(source, block.start), message } as Diagnostic)
        }
      }
    }
  }
  const rawBlocks = topLevelBlockTags(source)
  const emitBlock = (ruleName: string, block: RawBlockTag, message: string): void => {
    const entry = active.find(item => item.rule.name === ruleName)
    if (!entry || ruleOptions(config?.[ruleName]).configured !== true) return
    out.push({ filename, rule: ruleName, severity: entry.severity, ...sourceLoc(source, block.start), message } as Diagnostic)
  }
  for (const block of rawBlocks) {
    if (['template', 'script', 'style'].includes(block.type)
      && !block.content.trim() && !/\bsrc\s*=\s*(["'])[^"']+\1/u.test(block.attrs)) {
      emitBlock('vue/no-empty-component-block', block, `<${block.type}> is empty.`)
    }
  }
  const styleRule = active.find(entry => entry.rule.name === 'vue/enforce-style-attribute')
  if (styleRule && ruleOptions(config?.[styleRule.rule.name]).configured === true) {
    const options = ruleOptions(config?.[styleRule.rule.name])
    const allow = Array.isArray(options.allow) ? options.allow.map(String) : ['scoped']
    for (const block of rawBlocks.filter(item => item.type === 'style')) {
      const kind = /\bscoped\b/u.test(block.attrs) ? 'scoped' : /\bmodule\b/u.test(block.attrs) ? 'module' : 'plain'
      if (!allow.includes(kind)) out.push({ filename, rule: styleRule.rule.name, severity: styleRule.severity,
        ...sourceLoc(source, block.start), message: `${kind} style blocks are not allowed.` } as Diagnostic)
    }
  }
  const langRule = active.find(entry => entry.rule.name === 'vue/block-lang')
  if (langRule && ruleOptions(config?.[langRule.rule.name]).configured === true) {
    const options = ruleOptions(config?.[langRule.rule.name])
    for (const block of rawBlocks) {
      const blockOption = options[block.type]
      if (!blockOption || typeof blockOption !== 'object') continue
      const setting = blockOption as { lang?: unknown, allowNoLang?: unknown }
      const match = block.attrs.match(/\blang\s*=\s*["']([^"']+)["']/u)
      const allowed = Array.isArray(setting.lang) ? setting.lang.map(String)
        : typeof setting.lang === 'string' ? [setting.lang] : []
      if ((!match && setting.allowNoLang === false) || (match && !allowed.includes(match[1]!))) {
        emitBlock(langRule.rule.name, block, `Unexpected language for <${block.type}>.`)
      }
    }
  }
  const paddingRule = active.find(entry => entry.rule.name === 'vue/padding-line-between-blocks')
  if (paddingRule && ruleOptions(config?.[paddingRule.rule.name]).configured === true) {
    const mode = ruleOptions(config?.[paddingRule.rule.name]).mode ?? 'always'
    for (let index = 1; index < rawBlocks.length; index++) {
      const previous = rawBlocks[index - 1]!
      const block = rawBlocks[index]!
      const between = source.slice(previous.closeStart, block.start)
      const blank = /\n\s*\n/u.test(between)
      if (mode === 'always' ? !blank : blank) emitBlock(paddingRule.rule.name, block, 'Unexpected padding between blocks.')
    }
  }
  const orderRule = active.find(entry => entry.rule.name === 'vue/block-order')
  if (orderRule && ruleOptions(config?.[orderRule.rule.name]).configured === true) {
    const options = ruleOptions(config?.[orderRule.rule.name])
    const order = Array.isArray(options.order) ? options.order.map(String) : ['script', 'template', 'style']
    let previous = -1
    for (const block of rawBlocks) {
      const current = order.indexOf(block.type)
      if (current >= 0 && current < previous) emitBlock(orderRule.rule.name, block, `<${block.type}> is out of order.`)
      if (current >= 0) previous = Math.max(previous, current)
    }
  }
  const tagNewlineRule = active.find(entry => entry.rule.name === 'vue/block-tag-newline')
  if (tagNewlineRule && ruleOptions(config?.[tagNewlineRule.rule.name]).configured === true) {
    for (const block of rawBlocks) {
      if (block.content && !block.content.startsWith('\n')) emitBlock(tagNewlineRule.rule.name, block, `Expected a line break after <${block.type}>.`)
      if (block.content && !block.content.endsWith('\n')) emitBlock(tagNewlineRule.rule.name, block, `Expected a line break before </${block.type}>.`)
    }
  }
  const rootRule = active.find(entry => entry.rule.name === 'vue/valid-template-root')
  if (rootRule && descriptor.template) {
    const block = descriptor.template
    const hasSrc = Object.hasOwn(block.attrs, 'src')
    const children = ast?.children ?? baseParse(block.content).children
    const meaningful = children.filter(child => child.loc.source.trim())
    const emitRoot = (message: string, position: ReturnType<typeof loc>): void => {
      out.push({ filename, rule: rootRule.rule.name, severity: rootRule.severity, message, ...position } as Diagnostic)
    }
    if (hasSrc) {
      for (const child of meaningful) {
        const position = ast
          ? loc(child)
          : sourceLoc(source, block.loc.start.offset + child.loc.start.offset)
        emitRoot("A template with a src attribute must be empty.", position)
      }
    } else if (!meaningful.length) {
      const opening = source.slice(0, block.loc.start.offset).lastIndexOf('<template')
      emitRoot('The template requires a child element.', sourceLoc(source, Math.max(0, opening)))
    }
  }
  const propRule = active.find(entry => entry.rule.name === 'vue/no-mutating-props')
  if (propRule) {
    const result = scriptPropMutations(descriptor, ruleOptions(config?.[propRule.rule.name]).shallowOnly === true)
    for (const name of result.instanceProps) {
      script.instanceProps.add(name)
      if (!script.props.has(name) && !script.bindings.has(name)) script.props.set(name, name)
    }
    for (const finding of result.findings) {
      const prefix = source.slice(0, finding.offset).split('\n')
      out.push({ filename, rule: propRule.rule.name, severity: propRule.severity,
        line: prefix.length, column: prefix.at(-1)!.length + 1, offset: finding.offset,
        message: `Unexpected mutation of prop '${finding.name}'.`,
        help: 'Props are read-only; emit an event or use a local copy.',
      })
    }
  }

  const annotate = (children: TemplateChildNode[], parent?: ElementNode): void => {
    let previousElement: ElementNode | undefined
    let foundElement = false
    for (let i = 0; i < children.length; i++) {
      const node = children[i]!
      if (node.type !== NodeTypes.ELEMENT) continue
      ;(node as AnnotatedElement).__parentTag = parent?.tag ?? 'template'
      if (parent) (node as AnnotatedElement).__parentElement = parent
      ;(node as AnnotatedElement).__firstElementChild = !foundElement
      foundElement = true
      ;(node as AnnotatedElement).__prevElementHasIf = previousElement != null
        && Boolean(findDir(previousElement, 'if') || findDir(previousElement, 'else-if'))
      if (previousElement) (previousElement as AnnotatedElement).__nextElement = node
      previousElement = node
      if (!findDir(node, 'if')) continue
      // Walk forward over the v-else-if branches that continue this chain.
      const chain: ElementNode[] = []
      for (let j = i + 1; j < children.length; j++) {
        const sib = children[j]!
        if (sib.type === NodeTypes.COMMENT || (sib.type === NodeTypes.TEXT && !sib.content.trim())) continue
        if (sib.type !== NodeTypes.ELEMENT) break
        if (findDir(sib, 'else-if')) { chain.push(sib); continue }
        break
      }
      ;(node as AnnotatedElement).__siblings = chain
    }
  }

  const walk = (
    node: AnyNode | undefined,
    inherited = new Set<string>(),
    insideVFor = false,
    depth = 0,
  ): void => {
    if (!node) return
    const locals = new Set(inherited)
    if (node.type === NodeTypes.ELEMENT) {
      for (const prop of node.props) {
        if (prop.type !== NodeTypes.DIRECTIVE) continue
        const loop = prop.forParseResult
        const expressions = prop.name === 'for' && loop ? [loop.value, loop.key, loop.index]
          : prop.name === 'slot' ? [prop.exp] : []
        for (const exp of expressions) for (const name of bindingNames(exp)) locals.add(name)
      }
    }
    const context = node as AnyNode & Annotations
    context.__script = script
    context.__locals = locals
    context.__outerLocals = inherited
    context.__insideVFor = insideVFor
    context.__depth = depth
    context.__computedNames = computedInfo.names
    context.__scriptNames = templateScriptNames
    if (emitInfo) context.__emitInfo = emitInfo
    const children = childrenOf(node)
    if (children.length) annotate(children, node.type === NodeTypes.ELEMENT ? node : undefined)
    for (const { rule, severity } of active) {
      rule.check(node, (d) => {
        // The `offset` key is always present, holding `undefined` when the node
        // had no location. `Diagnostic.offset` is optional-but-not-undefined,
        // so the cast records that this is the JS shape rather than a widening
        // of the shared type -- consumers already read it with `?? 0`.
        out.push({
          filename,
          severity,
          rule: rule.name,
          ...d,
        } as Diagnostic)
      }, ruleOptions(config?.[rule.name]))
    }
    const childInsideVFor = insideVFor
      || node.type === NodeTypes.ELEMENT && Boolean(findDir(node, 'for'))
    for (const child of children) walk(child, locals, childInsideVFor, depth + 1)
    // Directive bodies of <template v-slot> live in children already.
  }

  // The root's own children are siblings too, and nothing walks "into" the
  // root, so they need annotating before the traversal starts.
  const rootChildren = ast ? childrenOf(ast) : []
  if (rootChildren.length) annotate(rootChildren)
  walk(ast)
  return out
}

/**
 * The template children of a node. Only element-like nodes carry a
 * `TemplateChildNode[]`; the compound/expression nodes that also have a
 * `children` field hold something else entirely, so they walk as leaves --
 * which matches the JavaScript version, where those arrays never contained
 * anything the rules could match.
 */
function childrenOf(node: AnyNode): TemplateChildNode[] {
  switch (node.type) {
    case NodeTypes.ROOT:
    case NodeTypes.ELEMENT:
    case NodeTypes.IF_BRANCH:
    case NodeTypes.FOR:
      return node.children
    default:
      return []
  }
}

export const structuralRuleNames: string[] = RULES.map(r => r.name)
