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
import { isHTMLTag, isSVGTag, isMathMLTag } from '@vue/shared'
import { parse } from '@vue/compiler-sfc'
import { scriptPropMutations, templatePropMutations } from './prop-mutations.js'
import { analyzeScript } from './script-analysis.js'
import type { ScriptAnalysis } from './script-analysis.js'
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
  __firstElementChild?: boolean
  __depth?: number
  /** Full SFC source and template-content boundary for root-only checks. */
  __source?: string
  __templateContentStart?: number
  /** Identifiers declared by `defineProps` in `<script setup>`. */
  __script?: ScriptAnalysis
  __locals?: Set<string>
  __outerLocals?: Set<string>
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
