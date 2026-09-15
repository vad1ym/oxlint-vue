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
  return option && typeof option === 'object' ? option as Record<string, unknown> : { mode: option }
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

const RULES: Rule[] = [
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
      if (!script || (!script.props.size && !script.propObjects.size)) return
      const expressions = node.type === NodeTypes.INTERPOLATION
        ? [{ exp: node.content, name: '', loc: node.loc }]
        : node.props.filter((prop): prop is DirectiveNode => prop.type === NodeTypes.DIRECTIVE)
      for (const prop of expressions) {
        const ast = expressionAst(prop.exp)
        if (!ast) continue
        const locals = prop.name === 'if' ? context.__outerLocals : context.__locals
        const reported = new Set<import('./ast.js').AstNode>()
        walkIdentifiers(ast, (id, _parent, ancestors) => {
          if (locals?.has(id.name)) return
          const isObject = script.propObjects.has(id.name)
          const propName = script.props.get(id.name)
          if (!isObject && !propName) return
          let target: import('./ast.js').AstNode = id
          let depth = ancestors.length - 1
          let members = 0
          while (depth >= 0) {
            const parent = ancestors[depth]!
            if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.object === target) {
              members++
              target = parent
              depth--
            } else if ((parent.type === 'TSAsExpression' || parent.type === 'TSTypeAssertion'
              || parent.type === 'TSNonNullExpression' || parent.type === 'TSSatisfiesExpression'
              || parent.type === 'ParenthesizedExpression') && parent.expression === target) {
              target = parent
              depth--
            } else if (parent.type === 'ObjectProperty' && parent.value === target
              || parent.type === 'ObjectPattern' || parent.type === 'ArrayPattern'
              || parent.type === 'RestElement' && parent.argument === target) {
              target = parent
              depth--
            } else break
          }
          if (isObject && !members) return
          const parent = ancestors[depth]
          const mutation = (parent?.type === 'AssignmentExpression' && parent.left === target)
            || (parent?.type === 'UpdateExpression' && parent.argument === target)
            || (parent?.type === 'UnaryExpression' && parent.operator === 'delete' && parent.argument === target)
            || (prop.name === 'model' && target === ast)
            || (parent?.type === 'CallExpression' && parent.callee === target
              && (!isObject || members > 1)
              && target.type === 'MemberExpression'
              && (!target.computed || target.property.type === 'StringLiteral')
              && ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'].includes(staticName(target.property) ?? ''))
          const mutationNode = parent ?? target
          if (!mutation || reported.has(mutationNode)) return
          if (options.shallowOnly && (members > (isObject ? 1 : 0) || parent?.type === 'CallExpression')) return
          reported.add(mutationNode)
          report({
            ...astLoc(prop.exp!, mutationNode, ast),
            message: `Unexpected mutation of prop '${propName ?? id.name}'.`,
            help: 'Props are read-only; emit an event or use a local copy.',
          })
        })
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
  const script = analyzeScript(scriptContent)

  const annotate = (children: TemplateChildNode[]): void => {
    for (let i = 0; i < children.length; i++) {
      const node = children[i]!
      if (node.type !== NodeTypes.ELEMENT) continue
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

  const walk = (node: AnyNode | undefined, inherited = new Set<string>()): void => {
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
    const children = childrenOf(node)
    if (children.length) annotate(children)
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
    for (const child of children) walk(child, locals)
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
