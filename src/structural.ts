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
import { analyzeScript } from './script-analysis.js'
import type { ScriptAnalysis } from './script-analysis.js'
import { bindingNames, expressionAst, expressionKey, staticName, unwrap } from './ast.js'
import { ElementTypes, NodeTypes, walkIdentifiers } from '@vue/compiler-core'

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
  check: (node: AnyNode, report: Report) => void
}

function loc(node: { loc?: AnyNode['loc'] }): {
  line: number
  column: number
  offset: number | undefined
} {
  const s = node.loc?.start
  return { line: s?.line ?? 1, column: s?.column ?? 1, offset: s?.offset }
}

/**
 * Blank out string and template-literal contents, preserving length so any
 * offsets computed against the result still line up. Lets a rule scan real
 * code without matching text that merely looks like code.
 */
function stripLiterals(text: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') { out += '  '; i++; continue }
      if (c === quote) { quote = null; out += c; continue }
      out += ' '
      continue
    }
    if (c === '"' || c === '\'' || c === '`') { quote = c; out += c; continue }
    out += c
  }
  return out
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
  if (!arg || arg.type !== NodeTypes.SIMPLE_EXPRESSION) return undefined
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
  if (node.type === 'OptionalMemberExpression' || node.type === 'OptionalCallExpression') return true
  return node.type === 'MemberExpression' && hasOptionalReceiver(node.object)
}

const RULES: Rule[] = [
  {
    name: 'vue/require-v-for-key',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const vFor = findDir(node, 'for')
      if (!vFor) return
      if (hasKeyBinding(node)) return
      report({
        ...loc(vFor),
        message: `<${node.tag}> with 'v-for' must have a ':key'.`,
        help: 'Add a unique :key binding to help Vue track each item.',
      })
    },
  },
  {
    name: 'vue/no-v-for-template-key-on-child',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || node.tag !== 'template' || !findDir(node, 'for')) return
      for (const child of node.children) {
        if (child.type !== NodeTypes.ELEMENT || findDir(child, 'for') || !hasKeyBinding(child)) continue
        report({
          ...loc(child),
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
        const raw = expressionAst(prop.exp)
        const target = raw && unwrap(raw)
        const native = node.tagType === ElementTypes.ELEMENT
        let problem: string | null = null
        if (!target) problem = 'requires a writable expression'
        else if (target.type !== 'Identifier' && target.type !== 'MemberExpression') problem = 'requires an assignable variable or member expression'
        else if (hasOptionalReceiver(target)) problem = 'cannot assign through optional chaining'
        else if (target.type === 'Identifier' && context.__locals?.has(target.name)) problem = 'cannot assign directly to a loop or slot variable'
        else if (native && !['input', 'textarea', 'select'].includes(node.tag)) problem = `is not supported on <${node.tag}>`
        else if (native && prop.arg) problem = 'cannot have an argument on a native element'
        else if (native && prop.modifiers.some(modifier => !['lazy', 'trim', 'number'].includes(modifier.content))) problem = 'has an unsupported modifier on a native element'
        else if (native && node.tag === 'input' && findAttr(node, 'type')?.value?.content.toLowerCase() === 'file') problem = 'cannot write to a file input'
        if (problem) report({
          ...loc(prop),
          message: `v-model ${problem}.`,
          help: 'Bind a writable state variable or property on an input, textarea, select, or component.',
        })
      }
    },
  },
  {
    name: 'vue/no-v-html',
    severity: 'warning',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const dir = findDir(node, 'html')
      if (!dir) return
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
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const vFor = findDir(node, 'for')
      const vIf = findDir(node, 'if')
      if (!vFor || !vIf) return
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
        ...loc(node),
        message: `'<template>' cannot be keyed.`,
        help: 'Place the key on a real element instead.',
      })
    },
  },
  {
    name: 'vue/no-useless-mustaches',
    severity: 'warning',
    check(node, report) {
      if (node.type !== NodeTypes.INTERPOLATION) return
      const c = node.content
      if (!c || c.type !== NodeTypes.SIMPLE_EXPRESSION) return
      const text = (c.content || '').trim()
      // A mustache wrapping nothing but a string literal is just static text.
      if (!/^(['"])(?:(?!\1)[^\\])*\1$/.test(text)) return
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
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const seen = new Map<string, AttributeNode | DirectiveNode>()
      for (const p of node.props) {
        // `:foo` and `foo` collide; `class`/`style` legitimately merge.
        const name = p.type === NodeTypes.DIRECTIVE
          ? (p.name === 'bind' && argContent(p)) || null
          : p.name
        if (!name || name === 'class' || name === 'style') continue
        if (seen.has(name)) {
          report({
            ...loc(p),
            message: `Duplicate attribute '${name}'.`,
            help: 'Remove the duplicate binding.',
          })
          continue
        }
        seen.set(name, p)
      }
    },
  },
  {
    name: 'vue/require-component-is',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || node.tag !== 'component') return
      const hasIs = node.props.some(p =>
        (p.type === NodeTypes.ATTRIBUTE && p.name === 'is')
        || (p.type === NodeTypes.DIRECTIVE && p.name === 'bind' && argContent(p) === 'is'))
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
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT || node.tagType !== ElementTypes.COMPONENT) return
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
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const dir = findDir(node, 'for')
      if (!dir) return
      // compiler-sfc leaves forParseResult undefined when the expression is
      // not a valid `alias in expression` form.
      if (dir.forParseResult?.source) return
      report({
        ...loc(dir),
        message: `'v-for' has an invalid expression.`,
        help: 'Use the form "item in items" or "(item, index) in items".',
      })
    },
  },
  {
    name: 'vue/no-useless-v-bind',
    severity: 'warning',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      for (const p of node.props) {
        if (p.type !== NodeTypes.DIRECTIVE || p.name !== 'bind') continue
        const exp = p.exp
        if (!exp || exp.type !== NodeTypes.SIMPLE_EXPRESSION || exp.isStatic) continue
        const text = String(exp.content).trim()
        // `:foo="'bar'"` is just `foo="bar"`.
        if (!/^(['"])(?:(?!\1)[^\\])*\1$/.test(text)) continue
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
    check(node, report) {
      const exps: NonNullable<DirectiveNode['exp']>[] = []
      if (node.type === NodeTypes.INTERPOLATION && node.content) exps.push(node.content)
      if (node.type === NodeTypes.ELEMENT) {
        for (const p of node.props) {
          if (p.type !== NodeTypes.DIRECTIVE || !p.exp) continue
          // `:onerror="\`this.src = ...\`"` binds a DOM handler as a string;
          // the `this` there is the element at runtime, not the component.
          const arg = argContent(p)
          if (p.name === 'bind' && typeof arg === 'string' && /^on[a-z]/.test(arg)) {
            continue
          }
          exps.push(p.exp)
        }
      }
      for (const e of exps) {
        if (e.type !== NodeTypes.SIMPLE_EXPRESSION || e.isStatic) continue
        const text = String(e.content)
        // `this` inside a string or template literal is not a template
        // expression reference either.
        if (!/(^|[^\w$.])this\s*\./.test(stripLiterals(text))) continue
        report({
          ...loc(e),
          message: `Unexpected usage of 'this' in a template.`,
          help: 'Template expressions resolve against the instance already.',
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
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      const attr = findAttr(node, 'style')
      if (!attr?.value?.content?.trim()) return
      report({
        ...loc(attr),
        message: 'Static inline styles are hard to override and reuse.',
        help: 'Move the declarations into a class.',
      })
    },
  },
  {
    name: 'vue/no-dupe-v-else-if',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      // compiler-sfc keeps the chain flat among siblings, so the branches are
      // collected by walking forward from the `v-if` over `v-else-if` nodes.
      if (!findDir(node, 'if')) return
      const seen = new Set<string>()
      const first = findDir(node, 'if')
      const firstKey = expressionKey(first?.exp)
      if (firstKey) seen.add(firstKey)

      for (const sib of (node as AnnotatedElement).__siblings ?? []) {
        const elif = findDir(sib, 'else-if')
        if (!elif?.exp) continue
        const key = expressionKey(elif.exp)
        if (!key) continue
        if (seen.has(key)) {
          report({
            ...loc(elif),
            message: 'This branch can never execute: its condition is a '
              + 'duplicate of an earlier one in the chain.',
            help: 'Remove the duplicate branch or fix its condition.',
          })
          continue
        }
        seen.add(key)
      }
    },
  },
  {
    name: 'vue/no-mutating-props',
    severity: 'error',
    check(node, report) {
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
        const reported = new Set<string>()
        walkIdentifiers(ast, (id, _parent, ancestors) => {
          if (locals?.has(id.name)) return
          const isObject = script.propObjects.has(id.name)
          const propName = script.props.get(id.name)
          if (!isObject && !propName) return
          let target: import('./ast.js').AstNode = id
          let depth = ancestors.length - 1
          let member = false
          while (depth >= 0) {
            const parent = ancestors[depth]!
            if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.object === target) {
              member = true
              target = parent
              depth--
            } else if (parent.type === 'ObjectProperty' && parent.value === target
              || parent.type === 'ObjectPattern' || parent.type === 'ArrayPattern'
              || parent.type === 'RestElement' && parent.argument === target) {
              target = parent
              depth--
            } else break
          }
          if (isObject && !member) return
          const parent = ancestors[depth]
          const mutation = (parent?.type === 'AssignmentExpression' && parent.left === target)
            || (parent?.type === 'UpdateExpression' && parent.argument === target)
            || (parent?.type === 'UnaryExpression' && parent.operator === 'delete' && parent.argument === target)
            || (prop.name === 'model' && target === ast)
            || (parent?.type === 'CallExpression' && parent.callee === target
              && target.type === 'MemberExpression'
              && (!target.computed || target.property.type === 'StringLiteral')
              && ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'].includes(staticName(target.property) ?? ''))
          if (!mutation || reported.has(id.name)) return
          reported.add(id.name)
          report({
            ...loc(prop),
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
      const interp = node.children.find(
        (c): c is InterpolationNode => c.type === NodeTypes.INTERPOLATION,
      )
      if (!interp) return
      report({
        ...loc(interp),
        message: 'Interpolation inside <textarea> is not rendered.',
        help: 'Use v-model or :value instead.',
      })
    },
  },
  {
    name: 'vue/no-child-content',
    severity: 'error',
    check(node, report) {
      if (node.type !== NodeTypes.ELEMENT) return
      for (const name of ['html', 'text']) {
        const dir = findDir(node, name)
        if (!dir) continue
        // Whitespace-only children are not real content.
        const hasContent = node.children.some(c =>
          (c.type === NodeTypes.TEXT && c.content.trim())
          || c.type === NodeTypes.ELEMENT
          || c.type === NodeTypes.INTERPOLATION)
        if (!hasContent) continue
        report({
          ...loc(dir),
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
      })
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
