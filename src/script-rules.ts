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
    const object = callee.type === 'MemberExpression' ? unwrap(callee.object) : null
    const factory = callee.type === 'Identifier' && ['defineComponent', 'defineNuxtComponent'].includes(callee.name)
      || callee.type === 'MemberExpression' && object?.type === 'Identifier'
        && object.name === 'Vue' && staticName(callee.property) === 'extend'
    if (factory) path = (path.get('arguments') as NodePath[])[0] ?? path
  }
  return path.isObjectExpression() ? path : undefined
}

export interface RegisteredComponent { name: string, offset: number }
export interface RefOperandFinding { method: string, offset: number }
export interface DefaultPropFinding { offset: number }
export interface ComputedPropertyInfo { names: Set<string>, findings: { offset: number }[] }

const nativePropTypes = new Set(['String', 'Number', 'Boolean', 'Function', 'Object', 'Array', 'Symbol', 'BigInt'])

function objectPropertyPath(object: NodePath, name: string): NodePath | undefined {
  if (!object.isObjectExpression()) return undefined
  return (object.get('properties') as NodePath[]).find(property =>
    (property.isObjectProperty() || property.isObjectMethod()) && !property.node.computed
    && staticName(property.node.key) === name)
}

function pathValue(path: NodePath): NodePath {
  if (path.isObjectProperty()) return path.get('value') as NodePath
  return path
}

function propTypes(path: NodePath): string[] {
  while (['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression'].includes(path.node.type)) path = path.get('expression') as NodePath
  if (path.isIdentifier()) return [path.node.name]
  if (path.isArrayExpression()) return (path.get('elements') as NodePath[]).flatMap(element =>
    element?.isIdentifier() ? [element.node.name] : [])
  return []
}

function defaultValueType(path: NodePath): string | null {
  while (['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'].includes(path.node.type)) path = path.get('expression') as NodePath
  if (path.isStringLiteral() || path.isTemplateLiteral()) return 'String'
  if (path.isNumericLiteral()) return 'Number'
  if (path.isBooleanLiteral()) return 'Boolean'
  if (path.isBigIntLiteral()) return 'BigInt'
  if (path.isArrayExpression()) return 'Array'
  if (path.isObjectExpression()) return 'Object'
  if (path.isFunctionExpression() || path.isArrowFunctionExpression()) return 'Function'
  if (path.isCallExpression() || path.isOptionalCallExpression()) {
    const callee = unwrap(path.node.callee)
    if (callee.type === 'Identifier' && nativePropTypes.has(callee.name)) return callee.name
  }
  return null
}

function inferTsTypes(node: AstNode | undefined, aliases: Map<string, AstNode>): string[] {
  if (!node) return []
  if (node.type === 'TSStringKeyword' || node.type === 'TSLiteralType'
    && (node.literal.type === 'StringLiteral' || node.literal.type === 'TemplateLiteral')) return ['String']
  if (node.type === 'TSNumberKeyword' || node.type === 'TSLiteralType' && node.literal.type === 'NumericLiteral') return ['Number']
  if (node.type === 'TSBooleanKeyword' || node.type === 'TSLiteralType' && node.literal.type === 'BooleanLiteral') return ['Boolean']
  if (node.type === 'TSFunctionType') return ['Function']
  if (node.type === 'TSArrayType' || node.type === 'TSTupleType') return ['Array']
  if (node.type === 'TSTypeLiteral' || node.type === 'TSMappedType' || node.type === 'TSObjectKeyword') return ['Object']
  if (node.type === 'TSUnionType') return [...new Set(node.types.flatMap(type => inferTsTypes(type, aliases)))]
  if (node.type === 'TSTypeReference' && node.typeName.type === 'Identifier') {
    if (['Array', 'ReadonlyArray'].includes(node.typeName.name)) return ['Array']
    if (['Record', 'Object'].includes(node.typeName.name)) return ['Object']
    return inferTsTypes(aliases.get(node.typeName.name), aliases)
  }
  if (node.type === 'TSLiteralType' && node.literal.type === 'BigIntLiteral') return ['BigInt']
  if (node.type === 'TSTemplateLiteralType') return ['String']
  return []
}

function functionReturnValues(fn: NodePath): NodePath[] {
  if (fn.isArrowFunctionExpression() && !fn.get('body').isBlockStatement()) return [fn.get('body') as NodePath]
  const values: NodePath[] = []
  fn.traverse({ ReturnStatement(path) {
    if (path.getFunctionParent() === fn && path.node.argument) values.push(path.get('argument') as NodePath)
  } })
  return values
}

/** Invalid runtime prop defaults. Type-only edge cases are intentionally inferred separately. */
export function validDefaultPropFindings(descriptor: SFCDescriptor, source: string): DefaultPropFinding[] {
  const findings: DefaultPropFinding[] = []
  const realBlocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null)
  const blocks = realBlocks.length ? realBlocks.map(block => ({ content: block.content,
    offset: block.loc.start.offset, setup: block === descriptor.scriptSetup }))
    : [{ content: source, offset: 0, setup: false }]
  for (const block of blocks) {
    let file
    try { file = babelParse(block.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) }
    catch { continue }
    const aliases = new Map<string, AstNode>()
    traverse(file, { enter(path) {
      if (path.isTSTypeAliasDeclaration()) aliases.set(path.node.id.name, path.node.typeAnnotation)
      if (path.isTSInterfaceDeclaration()) aliases.set(path.node.id.name, path.node.body)
    } })
    const report = (path: NodePath): void => {
      findings.push({ offset: block.offset + (path.node.start ?? 0) })
    }
    const validate = (value: NodePath, types: string[], sourceKind: 'property' | 'assignment'): void => {
      const expected = new Set(types.filter(type => nativePropTypes.has(type)))
      if (!expected.size) return
      while (['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'].includes(value.node.type)) value = value.get('expression') as NodePath
      if (value.isFunctionExpression() || value.isArrowFunctionExpression() || value.isObjectMethod()) {
        if (expected.has('Function')) return
        if (sourceKind === 'assignment') { report(value); return }
        if (value.isArrowFunctionExpression() && !value.get('body').isBlockStatement()) {
          const body = value.get('body') as NodePath
          const actual = defaultValueType(body)
          if (actual && !expected.has(actual)) report(body)
          return
        }
        value.traverse({ ReturnStatement(path) {
          if (path.getFunctionParent() !== value || !path.node.argument) return
          const argument = path.get('argument') as NodePath
          const actual = defaultValueType(argument)
          if (actual && !expected.has(actual)) report(argument)
        } })
        return
      }
      const actual = defaultValueType(value)
      if (!actual) return
      if (expected.has(actual) && (sourceKind === 'assignment' || !['Object', 'Array'].includes(actual))) return
      report(value)
    }
    const processProps = (props: NodePath, defaults?: NodePath, destructure?: NodePath): void => {
      while (['TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression'].includes(props.node.type)) props = props.get('expression') as NodePath
      if (!props.isObjectExpression()) return
      const definitions = new Map<string, string[]>()
      for (const property of props.get('properties') as NodePath[]) {
        if (!property.isObjectProperty()) continue
        const name = staticName(property.node.key)
        if (name === null) continue
        let config = property.get('value') as NodePath
        while (['TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression'].includes(config.node.type)) config = config.get('expression') as NodePath
        const typePath = config.isObjectExpression() ? objectPropertyPath(config, 'type') : undefined
        const types = propTypes(typePath ? pathValue(typePath) : config)
        definitions.set(name, types)
        if (config.isObjectExpression()) {
          const defaultPath = objectPropertyPath(config, 'default')
          if (defaultPath) validate(pathValue(defaultPath), types, 'property')
        }
      }
      if (defaults?.isObjectExpression()) for (const property of defaults.get('properties') as NodePath[]) {
        if (!property.isObjectProperty() && !property.isObjectMethod()) continue
        const name = staticName(property.node.key)
        if (name !== null) validate(pathValue(property), definitions.get(name) ?? [], 'property')
      }
      if (destructure?.isObjectPattern()) for (const property of destructure.get('properties') as NodePath[]) {
        if (!property.isObjectProperty()) continue
        const name = staticName(property.node.key)
        const value = property.get('value') as NodePath
        if (name !== null && value.isAssignmentPattern()) validate(value.get('right') as NodePath,
          definitions.get(name) ?? [], 'assignment')
      }
    }
    const typedProps = (call: NodePath): Map<string, string[]> => {
      const node = call.node as AstNode & { typeParameters?: { params?: AstNode[] }, typeArguments?: { params?: AstNode[] } }
      let root = node.typeParameters?.params?.[0] ?? node.typeArguments?.params?.[0]
      if (root?.type === 'TSTypeReference' && root.typeName.type === 'Identifier') root = aliases.get(root.typeName.name)
      const members = root?.type === 'TSTypeLiteral' ? root.members
        : root?.type === 'TSInterfaceBody' ? root.body : []
      const definitions = new Map<string, string[]>()
      for (const member of members) {
        if (member.type !== 'TSPropertySignature') continue
        const name = staticName(member.key)
        if (name !== null) definitions.set(name, inferTsTypes(member.typeAnnotation?.typeAnnotation, aliases))
      }
      return definitions
    }
    const processTypedDefaults = (definitions: Map<string, string[]>, defaults?: NodePath,
      destructure?: NodePath): void => {
      if (defaults?.isObjectExpression()) for (const property of defaults.get('properties') as NodePath[]) {
        if (!property.isObjectProperty() && !property.isObjectMethod()) continue
        const name = staticName(property.node.key)
        if (name !== null) validate(pathValue(property), definitions.get(name) ?? [], 'property')
      }
      if (destructure?.isObjectPattern()) for (const property of destructure.get('properties') as NodePath[]) {
        if (!property.isObjectProperty()) continue
        const name = staticName(property.node.key)
        const value = property.get('value') as NodePath
        if (name !== null && value.isAssignmentPattern()) validate(value.get('right') as NodePath,
          definitions.get(name) ?? [], 'assignment')
      }
    }
    traverse(file, { enter(path) {
      if (path.isExportDefaultDeclaration()) {
        const object = componentObject(path)
        const props = object && objectPropertyPath(object, 'props')
        if (props?.isObjectProperty()) processProps(props.get('value') as NodePath)
      }
      if (!path.isCallExpression() || path.node.callee.type !== 'Identifier') return
      if (path.node.callee.name === 'defineProps') {
        const runtime = (path.get('arguments') as NodePath[])[0]
        const parent = path.parentPath
        const wrapped = parent?.isCallExpression() && parent.node.callee.type === 'Identifier'
          && parent.node.callee.name === 'withDefaults'
        const declarator = (wrapped ? parent.parentPath : parent)?.isVariableDeclarator()
          ? (wrapped ? parent!.parentPath : parent) : undefined
        const defaults = wrapped ? (parent!.get('arguments') as NodePath[])[1] : undefined
        const id = declarator?.isVariableDeclarator() ? declarator.get('id') as NodePath : undefined
        if (runtime) processProps(runtime, defaults, id)
        else processTypedDefaults(typedProps(path), defaults, id)
      }
      if (path.node.callee.name === 'defineModel') {
        const args = path.get('arguments') as NodePath[]
        const options = args.find(argument => argument.isObjectExpression())
        if (!options) return
        const type = objectPropertyPath(options, 'type')
        const def = objectPropertyPath(options, 'default')
        if (type && def) validate(pathValue(def), propTypes(pathValue(type)), 'property')
        else if (def) {
          const node = path.node as AstNode & { typeParameters?: { params?: AstNode[] }, typeArguments?: { params?: AstNode[] } }
          const annotation = node.typeParameters?.params?.[0] ?? node.typeArguments?.params?.[0]
          validate(pathValue(def), inferTsTypes(annotation, aliases), 'property')
        }
      }
    } })
  }
  return findings
}

/** Computed properties that cannot return functions, plus `this.foo()` calls in component code. */
export function computedPropertyInfo(descriptor: SFCDescriptor): ComputedPropertyInfo {
  const names = new Set<string>()
  const findings: { offset: number }[] = []
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block || !['js', 'jsx', 'ts', 'tsx'].includes(block.lang ?? 'js')) continue
    let file
    try { file = babelParse(block.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) }
    catch { continue }
    traverse(file, { enter(exportPath) {
      if (!exportPath.isExportDefaultDeclaration()) return
      const object = componentObject(exportPath)
      if (!object) return
      const groups = (group: string): NodePath | undefined => {
        const property = objectPropertyPath(object, group)
        return property && (property.isObjectProperty() || property.isObjectMethod())
          ? pathValue(property) : undefined
      }
      const dataValues = new Map<string, NodePath>()
      const propFunctions = new Map<string, boolean>()
      const functions = new Map<string, NodePath>()
      const computed = new Map<string, NodePath>()
      const maybeFunctionType = (value: NodePath, seen = new Set<Binding>()): boolean => {
        while (['TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression'].includes(value.node.type)) value = value.get('expression') as NodePath
        if (value.isIdentifier()) {
          if (nativePropTypes.has(value.node.name)) return value.node.name === 'Function'
          const binding = value.scope.getBinding(value.node.name)
          if (!binding || seen.has(binding)) return true
          seen.add(binding)
          const expressions: NodePath[] = []
          if (binding.path.isVariableDeclarator() && binding.path.node.init) expressions.push(binding.path.get('init') as NodePath)
          for (const violation of binding.constantViolations) {
            if (violation.isAssignmentExpression()) expressions.push(violation.get('right') as NodePath)
          }
          return !expressions.length || expressions.some(expression => maybeFunctionType(expression, seen))
        }
        if (value.isArrayExpression()) return (value.get('elements') as NodePath[])
          .some(element => element && maybeFunctionType(element, seen))
        if (value.isConditionalExpression()) return maybeFunctionType(value.get('consequent') as NodePath, seen)
          || maybeFunctionType(value.get('alternate') as NodePath, seen)
        if (value.isLogicalExpression()) return maybeFunctionType(value.get('left') as NodePath, seen)
          || maybeFunctionType(value.get('right') as NodePath, seen)
        return true
      }
      const data = groups('data')
      if (data?.isFunction()) data.traverse({ ReturnStatement(path) {
        if (path.getFunctionParent() !== data || !path.get('argument').isObjectExpression()) return
        for (const property of (path.get('argument') as NodePath).get('properties') as NodePath[]) {
          if (!property.isObjectProperty()) continue
          const name = staticName(property.node.key)
          if (name !== null) dataValues.set(name, pathValue(property))
        }
      } })
      const props = groups('props')
      if (props?.isObjectExpression()) for (const property of props.get('properties') as NodePath[]) {
        if (!property.isObjectProperty()) continue
        const name = staticName(property.node.key)
        if (name === null) continue
        const value = pathValue(property)
        const type = value.isObjectExpression() ? objectPropertyPath(value, 'type') : undefined
        propFunctions.set(name, maybeFunctionType(type ? pathValue(type) : value))
      }
      for (const group of ['methods', 'computed']) {
        const value = groups(group)
        if (!value?.isObjectExpression()) continue
        for (const property of value.get('properties') as NodePath[]) {
          if (!property.isObjectProperty() && !property.isObjectMethod()) continue
          const name = staticName(property.node.key)
          if (name === null) continue
          let fn = pathValue(property)
          if (group === 'computed' && fn.isObjectExpression()) {
            const getter = objectPropertyPath(fn, 'get')
            if (getter) fn = pathValue(getter)
          }
          if (!fn.isFunction()) continue
          ;(group === 'computed' ? computed : functions).set(name, fn)
        }
      }
      const maybeFunction = (value: NodePath, seen = new Set<string>()): boolean => {
        while (['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'].includes(value.node.type)) value = value.get('expression') as NodePath
        if (value.isFunction()) return true
        if (value.isLiteral() || value.isArrayExpression() || value.isObjectExpression()
          || value.isBinaryExpression() || value.isUnaryExpression() || value.isUpdateExpression()
          || value.isTemplateLiteral()) return false
        if (value.isConditionalExpression()) return maybeFunction(value.get('consequent') as NodePath, seen)
          || maybeFunction(value.get('alternate') as NodePath, seen)
        if (value.isLogicalExpression()) return maybeFunction(value.get('left') as NodePath, seen)
          || maybeFunction(value.get('right') as NodePath, seen)
        if (value.isMemberExpression() && value.get('object').isThisExpression()) {
          const name = staticName(value.node.property)
          if (name && dataValues.has(name)) return maybeFunction(dataValues.get(name)!, seen)
          if (name && propFunctions.has(name)) return propFunctions.get(name)!
          if (name && computed.has(name) && !seen.has(name)) {
            seen.add(name)
            return functionReturnValues(computed.get(name)!).some(result => maybeFunction(result, seen))
          }
        }
        if (value.isCallExpression() && value.get('callee').isMemberExpression()) {
          const callee = value.get('callee') as NodePath
          if (callee.get('object').isThisExpression()) {
            const name = staticName(value.node.callee.type === 'MemberExpression'
              ? value.node.callee.property : callee.node)
            if (name && functions.has(name) && !seen.has(name)) {
              seen.add(name)
              return functionReturnValues(functions.get(name)!).some(result => maybeFunction(result, seen))
            }
          }
        }
        if (value.isIdentifier()) {
          const binding = value.scope.getBinding(value.node.name)
          if (binding?.path.isVariableDeclarator() && binding.path.node.init) return maybeFunction(binding.path.get('init') as NodePath, seen)
        }
        return true
      }
      for (const [name, fn] of computed) {
        if (!functionReturnValues(fn).some(value => maybeFunction(value))) names.add(name)
      }
      const instanceAliases = new Set<Binding>()
      object.traverse({ VariableDeclarator(path) {
        if (path.node.id.type !== 'Identifier' || path.node.init?.type !== 'ThisExpression') return
        const binding = path.scope.getBinding(path.node.id.name)
        if (binding?.constant) instanceAliases.add(binding)
      } })
      object.traverse({ CallExpression(path) {
        const callee = path.get('callee') as NodePath
        if (!callee.isMemberExpression()) return
        const receiver = callee.get('object') as NodePath
        const binding = receiver.isIdentifier() ? receiver.scope.getBinding(receiver.node.name) : undefined
        if (!receiver.isThisExpression() && !(binding && instanceAliases.has(binding))) return
        const name = staticName(callee.node.property)
        if (name && names.has(name)) findings.push({ offset: block.loc.start.offset + (path.node.start ?? 0) })
      } })
    } })
  }
  return { names, findings }
}

/** References to ref-like values used where JavaScript does not auto-unwrap them. */
export function refOperandFindings(
  descriptor: SFCDescriptor, source: string, allowGlobalRef = false,
): RefOperandFinding[] {
  const out: RefOperandFinding[] = []
  const realBlocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null)
  const blocks = realBlocks.length ? realBlocks.map(block => ({ content: block.content,
    offset: block.loc.start.offset, setup: block === descriptor.scriptSetup }))
    : [{ content: source, offset: 0, setup: false }]
  for (const block of blocks) {
    let file
    try { file = babelParse(block.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) }
    catch { continue }
    const factories = new Map<Binding, string>()
    const refs = new Map<Binding, string>()
    const definedAt = new Map<Binding, number>()
    const assignedLater = new Set<Binding>()
    const emitters = new Set<Binding>()
    traverse(file, { enter(path) {
      if (path.isImportSpecifier() && path.parentPath.isImportDeclaration()
        && ['vue', '@vue/composition-api'].includes(path.parentPath.node.source.value)) {
        const imported = staticName(path.node.imported)
        if (!imported || !['ref', 'computed', 'toRef', 'customRef', 'shallowRef'].includes(imported)) return
        const binding = path.scope.getBinding(path.node.local.name)
        if (binding) factories.set(binding, imported)
      }
    } })
    traverse(file, { enter(path) {
      if (!path.isVariableDeclarator() || !path.node.init) return
      const init = unwrap(path.node.init)
      if (init.type !== 'CallExpression' || init.callee.type !== 'Identifier') return
      if (block.setup && init.callee.name === 'defineEmits' && path.node.id.type === 'Identifier') {
        const binding = path.scope.getBinding(path.node.id.name)
        if (binding) emitters.add(binding)
        return
      }
      let method: string | undefined
      const factory = path.scope.getBinding(init.callee.name)
      if (factory) method = factories.get(factory)
      if (init.callee.name === 'defineModel') method = 'defineModel'
      if (allowGlobalRef && init.callee.name === 'ref' && !factory) method = 'ref'
      if (!method) return
      const ids = path.node.id.type === 'ArrayPattern' ? [path.node.id.elements[0]] : [path.node.id]
      for (const id of ids) if (id?.type === 'Identifier') {
        const binding = path.scope.getBinding(id.name)
        if (binding) {
          refs.set(binding, method)
          definedAt.set(binding, init.start ?? 0)
        }
      }
      return
    } })
    traverse(file, { enter(path) {
      if (!path.isAssignmentExpression() || path.node.operator !== '='
        || path.node.left.type !== 'Identifier') return
      const right = unwrap(path.node.right)
      if (right.type !== 'CallExpression' || right.callee.type !== 'Identifier') return
      const factory = path.scope.getBinding(right.callee.name)
      const method = factory ? factories.get(factory)
        : allowGlobalRef && right.callee.name === 'ref' ? 'ref' : undefined
      const binding = path.scope.getBinding(path.node.left.name)
      if (binding && method) {
        refs.set(binding, method)
        definedAt.set(binding, right.start ?? 0)
        assignedLater.add(binding)
      }
    } })
    traverse(file, { enter(path) {
      if (!path.isVariableDeclarator() || path.node.id.type !== 'Identifier'
        || path.node.init?.type !== 'Identifier') return
      const sourceBinding = path.scope.getBinding(path.node.init.name)
      if (!sourceBinding || !assignedLater.has(sourceBinding)) return
      const binding = path.scope.getBinding(path.node.id.name)
      const method = refs.get(sourceBinding)
      if (binding && method) {
        refs.set(binding, method)
        definedAt.set(binding, path.node.init.start ?? 0)
      }
    } })
    traverse(file, { enter(path) {
      if (!path.isIdentifier()) return
      const binding = path.scope.getBinding(path.node.name)
      const method = binding && refs.get(binding)
      if (!method) return
      if ((path.node.start ?? 0) < (definedAt.get(binding!) ?? 0)) return
      const parent = path.parentPath
      let invalid = parent.isIfStatement() && parent.get('test') === path
        || parent.isSwitchStatement() && parent.get('discriminant') === path
        || parent.isUnaryExpression() || parent.isUpdateExpression() || parent.isBinaryExpression()
        || parent.isConditionalExpression() && parent.get('test') === path
        || parent.isAssignmentExpression() && (parent.node.operator !== '=' || parent.get('left') === path)
      if (parent.isLogicalExpression() && parent.get('left') === path
        && binding?.path.parentPath?.isVariableDeclaration({ kind: 'const' })) invalid = true
      if (parent.isTemplateLiteral() && !parent.parentPath?.isTaggedTemplateExpression()) invalid = true
      if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.get('object') === path) {
        const name = parent.node.computed ? parent.node.property.type === 'StringLiteral'
          ? parent.node.property.value : null : staticName(parent.node.property)
        if (name !== 'value' && name !== 'effect' && name !== null) invalid = true
      }
      if (parent.isCallExpression() && parent.node.arguments.slice(1).some(argument => argument === path.node)
        && parent.node.arguments[0]?.type === 'StringLiteral') {
        if (parent.node.callee.type === 'Identifier') {
          const emitter = path.scope.getBinding(parent.node.callee.name)
          if (parent.node.callee.name === 'emit' || emitter && emitters.has(emitter)) invalid = true
        } else if (parent.node.callee.type === 'MemberExpression'
          && staticName(parent.node.callee.property) === 'emit') invalid = true
      }
      if (invalid) out.push({ method, offset: block.offset + (path.node.start ?? 0) })
    } })
  }
  return out
}

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
