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
export interface ComponentNameFinding { name: string, offset: number }

function componentObject(path: NodePath): NodePath | undefined {
  if (path.isExportDefaultDeclaration()) path = path.get('declaration') as NodePath
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

export interface RegisteredComponent { name: string, offset: number }

/** Components registered in Options API `components` objects. */
export function registeredComponents(descriptor: SFCDescriptor): RegisteredComponent[] {
  const out: RegisteredComponent[] = []
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block || !['js', 'jsx', 'ts', 'tsx'].includes(block.lang ?? 'js')) continue
    let file
    try { file = babelParse(block.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) }
    catch { continue }
    const inspect = (object: NodePath | undefined): void => {
      if (!object?.isObjectExpression()) return
      const components = (object.get('properties') as NodePath[]).find(property =>
        (property.isObjectProperty() || property.isObjectMethod())
        && staticName(property.node.key) === 'components')
      if (!components?.isObjectProperty()) return
      let value = components.get('value') as NodePath
      while (['TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression'].includes(value.node.type)) value = value.get('expression') as NodePath
      if (!value.isObjectExpression()) return
      for (const property of value.get('properties') as NodePath[]) {
        if (!property.isObjectProperty() && !property.isObjectMethod()) continue
        const key = property.node.key
        const name = property.node.computed
          ? key.type === 'StringLiteral' ? key.value
            : key.type === 'TemplateLiteral' && key.expressions.length === 0
              ? key.quasis[0]?.value.cooked ?? null : null
          : staticName(key)
        if (name !== null) out.push({ name, offset: block.loc.start.offset + (property.node.start ?? 0) })
      }
    }
    traverse(file, { enter(path) {
      if (path.isExportDefaultDeclaration()) inspect(componentObject(path))
      if (!path.isCallExpression()) return
      const callee = unwrap(path.node.callee)
      if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier'
        && callee.object.name === 'Vue' && staticName(callee.property) === 'component') {
        inspect((path.get('arguments') as NodePath[])[1])
      }
    } })
  }
  return out
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

const builtInComponentNames = new Set([
  'Transition', 'transition', 'TransitionGroup', 'transition-group',
  'KeepAlive', 'keep-alive', 'Teleport', 'teleport', 'Suspense', 'suspense',
  'Component', 'component',
])

function kebabName(name: string): string {
  return name.replace(/([a-z\d])([A-Z])/gu, '$1-$2').replace(/[_\s]+/gu, '-').toLowerCase()
}

/** Invalid explicit component names, or the filename fallback used by script setup/options components. */
export function componentNameFindings(
  descriptor: SFCDescriptor,
  filename: string,
  configuredIgnores: unknown,
): ComponentNameFinding[] {
  const ignores = new Set(['App', 'app'])
  if (Array.isArray(configuredIgnores)) for (const value of configuredIgnores) {
    if (typeof value !== 'string') continue
    ignores.add(value)
    if (/^[A-Z][\dA-Za-z]*$/u.test(value)) ignores.add(kebabName(value))
  }
  const valid = (name: string): boolean => ignores.has(name) || builtInComponentNames.has(name)
    || kebabName(name).includes('-')
  const findings: ComponentNameFinding[] = []
  let hasVue = descriptor.scriptSetup !== null
  let hasName = false
  let hasProgramBody = false

  const validate = (node: AstNode, blockOffset: number): void => {
    if (!['StringLiteral', 'NumericLiteral', 'BooleanLiteral'].includes(node.type)) return
    const name = String((node as AstNode & { value: unknown }).value)
    if (!valid(name)) findings.push({ name, offset: blockOffset + (node.start ?? 0) })
  }

  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block || !['js', 'jsx', 'ts', 'tsx'].includes(block.lang ?? 'js')) continue
    let file
    try {
      file = babelParse(block.content, {
        sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'],
      })
    } catch { continue }
    if (file.program.body.length) hasProgramBody = true
    traverse(file, { enter(path) {
      if (path.isCallExpression()) {
        const callee = unwrap(path.node.callee)
        if (callee.type === 'MemberExpression' && !callee.computed
          && callee.object.type === 'Identifier' && callee.object.name === 'Vue'
          && staticName(callee.property) === 'component') {
          hasVue = true
          if (path.node.arguments.length === 2) {
            hasName = true
            const name = (path.get('arguments') as NodePath[])[0]
            if (name) validate(name.node, block.loc.start.offset)
          }
        }
        if (block === descriptor.scriptSetup && callee.type === 'Identifier'
          && callee.name === 'defineOptions' && path.node.arguments[0]?.type === 'ObjectExpression') {
          const object = (path.get('arguments') as NodePath[])[0]!
          const property = (object.get('properties') as NodePath[]).find(candidate =>
            candidate.isObjectProperty() && staticName(candidate.node.key) === 'name')
          if (property?.isObjectProperty()) {
            hasName = true
            validate((property.get('value') as NodePath).node, block.loc.start.offset)
          }
        }
      }
      if (path.isExportDefaultDeclaration()) {
        const object = componentObject(path)
        if (!object) return
        hasVue = true
        const property = (object.get('properties') as NodePath[]).find(candidate =>
          candidate.isObjectProperty() && staticName(candidate.node.key) === 'name')
        if (property?.isObjectProperty()) {
          hasName = true
          validate((property.get('value') as NodePath).node, block.loc.start.offset)
        }
      }
    } })
  }

  if (!hasName && (hasVue || !hasProgramBody) && /\.vue$/iu.test(filename)) {
    const basename = filename.replace(/^.*[/\\]/u, '').replace(/\.[^.]*$/u, '')
    if (!valid(basename)) findings.push({ name: basename, offset: 0 })
  }
  return findings
}
