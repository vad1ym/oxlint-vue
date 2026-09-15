import traverseModule from '@babel/traverse'
import type { Binding, NodePath } from '@babel/traverse'
import { babelParse } from '@vue/compiler-sfc'
import type { SFCDescriptor } from '@vue/compiler-sfc'
import type { AstNode } from './ast.js'
import { staticName, unwrap } from './ast.js'
import type { ScriptAnalysis } from './script-analysis.js'

// Babel 7 exposes a CommonJS default on Node's native ESM loader.
const traverse = (typeof traverseModule === 'function' ? traverseModule
  : (traverseModule as unknown as { default: unknown }).default) as (node: AstNode, options: { enter: (path: NodePath) => void }) => void

interface Identity {
  name: string
  /** Distance from this root to the actual prop value. */
  propDepth: number
  /** Reassigning a destructured script local does not mutate its source. */
  writeDepth: number
  depth: number
  instance?: Set<string>
}
export interface PropMutation { node: AstNode, name: string }
type Resolve = (path: NodePath) => Identity | undefined
const mutators = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'])

function child(path: NodePath, key: string): NodePath {
  return path.get(key) as NodePath
}
function transparent(path: NodePath): NodePath {
  while (['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'].includes(path.node.type)) path = child(path, 'expression')
  return path
}
function member(path: NodePath): boolean {
  return path.isMemberExpression() || path.isOptionalMemberExpression()
}
function targetIdentity(path: NodePath, resolve: Resolve): Identity | undefined {
  path = transparent(path)
  if (!member(path)) return resolve(path)
  const identity = targetIdentity(child(path, 'object'), resolve)
  if (!identity) return undefined
  const node = path.node
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return undefined
  const name = node.computed ? node.property.type === 'StringLiteral' ? node.property.value : null : staticName(node.property)
  if (identity.instance && identity.depth === 0 && (!name || !identity.instance.has(name))) return undefined
  return { ...identity, depth: identity.depth + 1, name: identity.depth === 0 && identity.propDepth === 1 ? name ?? identity.name : identity.name }
}

/** Both template expressions and script bodies use the same mutation semantics. */
function mutations(ast: AstNode, resolve: Resolve, shallow: boolean, model: boolean, register?: (path: NodePath) => void, registerAlias?: (path: NodePath) => void): PropMutation[] {
  const file = babelParse('', { sourceType: 'module' })
  if (ast.type === 'Program') file.program = ast
  else file.program.body = [{ type: 'ExpressionStatement', expression: ast as Extract<AstNode, { type: 'ExpressionStatement' }>['expression'] }]
  const out: PropMutation[] = []
  const seen = new Map<AstNode, Set<string>>()
  const report = (path: NodePath, target: NodePath, call = false): void => {
    const identity = targetIdentity(target, resolve)
    if (!identity || identity.depth < (call ? identity.propDepth : identity.writeDepth)) return
    if (shallow && (call || identity.depth !== identity.propDepth)) return
    const names = seen.get(path.node) ?? new Set<string>()
    if (names.has(identity.name)) return
    names.add(identity.name)
    seen.set(path.node, names)
    out.push({ node: path.node, name: identity.name })
  }
  const assignment = (path: NodePath, target: NodePath): void => {
    target = transparent(target)
    if (target.isObjectPattern()) {
      for (const prop of target.get('properties')) assignment(path, child(prop, prop.isRestElement() ? 'argument' : 'value'))
    } else if (target.isArrayPattern()) {
      for (const element of target.get('elements')) if (element.node) assignment(path, element as NodePath)
    } else if (target.isAssignmentPattern()) assignment(path, child(target, 'left'))
    else if (target.isRestElement()) assignment(path, child(target, 'argument'))
    else report(path, target)
  }
  // Collect declarations first, so hoisted references and later declarations
  // use Babel's binding identity rather than traversal order or name strings.
  if (register) traverse(file, { enter: register })
  traverse(file, {
    enter(path) {
      registerAlias?.(path)
      if (model && path.node === ast) assignment(path, path)
      if (path.isAssignmentExpression()) assignment(path, child(path, 'left'))
      else if (path.isUpdateExpression()) report(path, child(path, 'argument'))
      else if (path.isUnaryExpression({ operator: 'delete' })) report(path, child(path, 'argument'))
      else if (path.isCallExpression() || path.isOptionalCallExpression()) {
        const callee = transparent(child(path, 'callee'))
        if (!member(callee)) return
        const property = child(callee, 'property').node
        const callNode = callee.node as Extract<AstNode, { type: 'MemberExpression' }>
        const name = callNode.computed ? property.type === 'StringLiteral' ? property.value : null : staticName(property)
        if (name && mutators.has(name)) report(path, child(callee, 'object'), true)
        if (name === 'assign' && child(callee, 'object').isIdentifier({ name: 'Object' }) && !path.scope.getBinding('Object')) {
          const argument = (path.get('arguments') as NodePath[])[0]
          if (argument?.node) report(path, argument, true)
        }
      }
    },
  })
  return out
}

export function templatePropMutations(ast: AstNode, analysis: ScriptAnalysis, locals: Set<string> | undefined, shallow: boolean, model: boolean): PropMutation[] {
  return mutations(ast, path => {
    if (path.isIdentifier()) {
      if (locals?.has(path.node.name) || path.scope.getBinding(path.node.name)) return undefined
      if (analysis.propObjects.has(path.node.name)) return { name: path.node.name, propDepth: 1, writeDepth: 1, depth: 0 }
      const name = analysis.props.get(path.node.name)
      if (name) return { name, propDepth: 0, writeDepth: 0, depth: 0 }
    } else if (path.isThisExpression()) {
      // Function callbacks have their own this. Arrow callbacks inherit it.
      if (path.findParent(p => p.isFunction() && !p.isArrowFunctionExpression())) return undefined
      return { name: 'this', propDepth: 1, writeDepth: 1, depth: 0, instance: analysis.instanceProps }
    }
    return undefined
  }, shallow, model)
}

function runtimeProps(node: AstNode | null | undefined): Set<string> {
  const names = new Set<string>()
  if (node?.type === 'ArrayExpression') {
    for (const value of node.elements) if (value?.type === 'StringLiteral') names.add(value.value)
  } else if (node?.type === 'ObjectExpression') {
    for (const property of node.properties) {
      if (property.type === 'SpreadElement' || property.computed) continue
      const name = staticName(property.key)
      if (name) names.add(name)
    }
  }
  return names
}

export interface ScriptPropResult {
  instanceProps: Set<string>
  findings: { offset: number, name: string }[]
}

export function scriptPropMutations(descriptor: SFCDescriptor, shallow: boolean): ScriptPropResult {
  const result: ScriptPropResult = { instanceProps: new Set(), findings: [] }
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block || !['js', 'jsx', 'ts', 'tsx'].includes(block.lang ?? 'js')) continue
    let file
    try { file = babelParse(block.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) } catch { continue }
    const identities = new Map<Binding, Identity>()
    const components = new Map<AstNode, Set<string>>()
    const bind = (pattern: NodePath, object: boolean): void => {
      if (pattern.isIdentifier()) {
        const binding = pattern.scope.getBinding(pattern.node.name)
        if (binding) identities.set(binding, { name: pattern.node.name, propDepth: object ? 1 : 0, writeDepth: 1, depth: 0 })
      } else if (pattern.isAssignmentPattern()) bind(child(pattern, 'left'), object)
      else if (pattern.isObjectPattern()) for (const prop of pattern.get('properties')) {
        if (prop.isRestElement()) bind(child(prop, 'argument'), object)
        else bind(child(prop, 'value'), false)
      }
      else if (pattern.isArrayPattern()) for (const element of pattern.get('elements')) {
        if (element.node) bind(element.isRestElement() ? child(element, 'argument') : element as NodePath, false)
      }
    }
    const register = (path: NodePath): void => {
      if (path.isExportDefaultDeclaration()) {
        let declaration = transparent(child(path, 'declaration'))
        if (declaration.isIdentifier()) {
          const binding = declaration.scope.getBinding(declaration.node.name)
          if (binding?.path.isVariableDeclarator() && binding.path.node.init) declaration = transparent(child(binding.path, 'init'))
        }
        if (declaration.isCallExpression()) {
          const callee = declaration.node.callee
          const factory = callee.type === 'Identifier' && ['defineComponent', 'defineNuxtComponent'].includes(callee.name)
            || callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'Vue' && staticName(callee.property) === 'extend'
          if (!factory) return
          declaration = (declaration.get('arguments') as NodePath[])[0] ?? declaration
        }
        if (!declaration.isObjectExpression()) return
        const props = declaration.get('properties').find(p => p.isObjectProperty() && staticName(p.node.key) === 'props')
        const names = runtimeProps(props?.isObjectProperty() ? props.node.value : undefined)
        components.set(declaration.node, names)
        for (const name of names) result.instanceProps.add(name)
        for (const property of declaration.get('properties')) {
          if (!(property.isObjectMethod() || property.isObjectProperty()) || property.node.computed || staticName(property.node.key) !== 'setup') continue
          const fn = property.isObjectMethod() ? property : child(property, 'value')
          if (!fn.isFunction()) continue
          const param = (fn.get('params') as NodePath[])[0]
          if (param?.isIdentifier() || param?.isObjectPattern()) bind(param, true)
        }
      }
      if (block !== descriptor.scriptSetup || !path.isVariableDeclarator() || !path.parentPath.parentPath?.isProgram()) return
      const init = path.node.init && unwrap(path.node.init)
      if (init?.type !== 'CallExpression') return
      const macro = init.callee.type === 'Identifier' && init.callee.name === 'withDefaults' ? init.arguments[0] : init
      if (macro?.type === 'CallExpression' && macro.callee.type === 'Identifier' && macro.callee.name === 'defineProps') bind(child(path, 'id'), true)
    }
    const resolve: Resolve = path => {
      if (path.isIdentifier()) {
        const binding = path.scope.getBinding(path.node.name)
        return binding ? identities.get(binding) : undefined
      }
      if (!path.isThisExpression()) return undefined
      const fn = path.findParent(p => p.isFunction() && !p.isArrowFunctionExpression())
      if (!fn || !(fn.isObjectMethod() || fn.parentPath?.isObjectProperty())) return undefined
      for (let owner = fn.parentPath; owner; owner = owner.parentPath!) {
        if (owner.isFunction()) return undefined
        const names = components.get(owner.node)
        if (names) return { name: 'this', propDepth: 1, writeDepth: 1, depth: 0, instance: names }
      }
      return undefined
    }
    const alias = (path: NodePath): void => {
      if (!path.isVariableDeclarator() || !path.get('id').isIdentifier() || !path.node.init) return
      const identifier = path.get('id')
      if (!identifier.isIdentifier()) return
      const binding = path.scope.getBinding(identifier.node.name)
      if (!binding?.constant || identities.has(binding)) return
      const origin = targetIdentity(child(path, 'init'), resolve)
      // Upstream resolves component-instance aliases, but does not propagate
      // arbitrary aliases of props or individual prop values.
      if (!origin?.instance || origin.depth !== 0) return
      identities.set(binding, { name: origin.name, propDepth: origin.propDepth - origin.depth, writeDepth: 1, depth: 0,
        ...(origin.instance && origin.depth === 0 ? { instance: origin.instance } : {}),
      })
    }
    for (const mutation of mutations(file.program, resolve, shallow, false, register, alias)) {
      result.findings.push({ offset: block.loc.start.offset + (mutation.node.start ?? 0), name: mutation.name })
    }
  }
  return result
}
