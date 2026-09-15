import traverseModule from '@babel/traverse'
import type { Binding, NodePath } from '@babel/traverse'
import { babelParse } from '@vue/compiler-sfc'
import type { SFCDescriptor } from '@vue/compiler-sfc'
import type { AstNode } from './ast.js'
import { staticName, unwrap } from './ast.js'

const traverse = (typeof traverseModule === 'function' ? traverseModule
  : (traverseModule as unknown as { default: unknown }).default) as (
  node: AstNode,
  options: { enter: (path: NodePath) => void },
) => void

function asFile(ast: AstNode): ReturnType<typeof babelParse> {
  const file = babelParse('', { sourceType: 'module' })
  if (ast.type === 'Program') file.program = ast
  else file.program.body = [{
    type: 'ExpressionStatement',
    expression: ast as Extract<AstNode, { type: 'ExpressionStatement' }>['expression'],
  }]
  return file
}

/** Unbound identifier references in a template expression. */
export function freeIdentifiers(ast: AstNode, names: Set<string>, locals?: Set<string>): AstNode[] {
  const out: AstNode[] = []
  traverse(asFile(ast), {
    enter(path) {
      if (!path.isReferencedIdentifier() || !names.has(path.node.name)
        || locals?.has(path.node.name) || path.scope.getBinding(path.node.name)) return
      out.push(path.node)
    },
  })
  return out
}

export interface ScriptMemberFinding { name: string, offset: number }

function componentObject(path: NodePath): NodePath | undefined {
  path = path.get('declaration') as NodePath
  while (['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'].includes(path.node.type)) path = path.get('expression') as NodePath
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name)
    if (binding?.path.isVariableDeclarator() && binding.path.node.init) path = binding.path.get('init') as NodePath
  }
  if (path.isCallExpression()) {
    const callee = unwrap(path.node.callee)
    const factory = callee.type === 'Identifier' && ['defineComponent', 'defineNuxtComponent'].includes(callee.name)
      || callee.type === 'MemberExpression' && callee.object.type === 'Identifier'
        && callee.object.name === 'Vue' && staticName(callee.property) === 'extend'
    if (factory) path = (path.get('arguments') as NodePath[])[0] ?? path
  }
  return path.isObjectExpression() ? path : undefined
}

/** Deprecated instance members used through component `this` or a constant alias. */
export function scriptInstanceMembers(
  descriptor: SFCDescriptor,
  names: Set<string>,
): ScriptMemberFinding[] {
  const findings: ScriptMemberFinding[] = []
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block || !['js', 'jsx', 'ts', 'tsx'].includes(block.lang ?? 'js')) continue
    let file
    try {
      file = babelParse(block.content, {
        sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'],
      })
    } catch { continue }
    const components = new Set<AstNode>()
    const aliases = new Set<Binding>()
    traverse(file, { enter(path) {
      if (path.isExportDefaultDeclaration()) {
        const object = componentObject(path)
        if (object) components.add(object.node)
      }
    } })
    const isComponentThis = (path: NodePath): boolean => {
      const fn = path.findParent(parent => parent.isFunction() && !parent.isArrowFunctionExpression())
      if (!fn) return false
      for (let owner = fn.parentPath; owner; owner = owner.parentPath) {
        if (owner.isFunction()) return false
        if (components.has(owner.node)) return true
      }
      return false
    }
    traverse(file, { enter(path) {
      if (!path.isVariableDeclarator() || !path.get('id').isIdentifier() || !path.node.init) return
      const init = path.get('init') as NodePath
      if (!init.isThisExpression() || !isComponentThis(init)) return
      const id = path.get('id') as NodePath
      if (!id.isIdentifier()) return
      const binding = path.scope.getBinding(id.node.name)
      if (binding?.constant) aliases.add(binding)
    } })
    traverse(file, { enter(path) {
      if (!path.isMemberExpression() && !path.isOptionalMemberExpression()) return
      const property = path.get('property') as NodePath
      if (!property.isIdentifier() || path.node.computed || !names.has(property.node.name)) return
      const object = path.get('object') as NodePath
      const binding = object.isIdentifier() ? object.scope.getBinding(object.node.name) : undefined
      const instance = object.isThisExpression() ? isComponentThis(object)
        : Boolean(binding && aliases.has(binding))
      if (instance) findings.push({
        name: property.node.name,
        offset: block.loc.start.offset + (property.node.start ?? 0),
      })
    } })
  }
  return findings
}
