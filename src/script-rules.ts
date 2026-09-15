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
export interface ComponentOrderFinding { name: string, offset: number }
export interface BooleanDefaultFinding { offset: number }
export interface ComponentOptionNameFinding { name: string, offset: number }
export interface ComponentOptionTypoFinding { name: string, candidates: string[], offset: number }
export interface ExplicitEmitInfo {
  declared: Set<string>
  props: Set<string>
  acceptsAny: boolean
  hasDefinition: boolean
  templateEmitters: Set<string>
  findings: { name: string, offset: number }[]
}

/** Component definition locations for one-component-per-file. */
export function componentDefinitionOffsets(descriptor: SFCDescriptor, source: string, filename: string): number[] {
  const blocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null)
  const inputs = blocks.length > 0 ? blocks.map(block => ({ content: block.content, offset: block.loc.start.offset }))
    : [{ content: source, offset: 0 }]
  const definitions: number[] = []
  for (const input of inputs) {
    let file
    try { file = babelParse(input.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) }
    catch { continue }
    const factories = new Map<Binding, string>()
    traverse(file, { enter(path) {
      if (path.isImportDeclaration() && ['vue', '@vue/composition-api'].includes(path.node.source.value)) {
        for (const specifier of path.get('specifiers') as NodePath[]) {
          if (!specifier.isImportSpecifier() || specifier.node.imported.type !== 'Identifier'
            || !['component', 'createApp', 'defineComponent'].includes(specifier.node.imported.name)) continue
          const binding = specifier.scope.getBinding(specifier.node.local.name)
          if (binding) factories.set(binding, specifier.node.imported.name)
        }
      }
      if (!path.isVariableDeclarator() || path.node.id.type !== 'Identifier') return
      const init = path.get('init') as NodePath
      if (!init?.isMemberExpression() || init.node.object.type !== 'Identifier' || init.node.object.name !== 'Vue') return
      const name = staticName(init.node.property)
      if (!name || !['component', 'createApp', 'defineComponent'].includes(name)) return
      const binding = path.scope.getBinding(path.node.id.name)
      if (binding) factories.set(binding, name)
    } })
    traverse(file, { enter(path) {
      const init = path.isVariableDeclarator() ? path.get('init') as NodePath : undefined
      const fromVue = init?.isIdentifier() && init.node.name === 'Vue'
        || init?.isCallExpression() && init.node.callee.type === 'Identifier' && init.node.callee.name === 'require'
          && staticString((init.get('arguments') as NodePath[])[0]) === 'vue'
      if (path.isVariableDeclarator() && path.node.id.type === 'ObjectPattern' && fromVue) {
        for (const property of path.get('id').get('properties') as NodePath[]) {
          if (!property.isObjectProperty() || property.node.value.type !== 'Identifier') continue
          const name = staticName(property.node.key)
          if (!name || !['component', 'createApp', 'defineComponent'].includes(name)) continue
          const binding = property.scope.getBinding(property.node.value.name)
          if (binding) factories.set(binding, name)
        }
      }
      if (path.isExportDefaultDeclaration() && filename.endsWith('.vue')) {
        const object = componentObject(path)
        if (object?.node.start !== null && object?.node.start !== undefined) definitions.push(input.offset + object.node.start)
      }
      if (!path.isCallExpression()) return
      let factory: string | undefined
      const callee = path.get('callee') as NodePath
      if (callee.isMemberExpression() && callee.node.object.type === 'Identifier'
        && callee.node.object.name === 'Vue' && staticName(callee.node.property) === 'component') factory = 'component'
      else if (callee.isIdentifier()) {
        const binding = callee.scope.getBinding(callee.node.name)
        factory = binding ? factories.get(binding)
          : filename.endsWith('.vue') && callee.node.name === 'defineComponent' ? 'defineComponent' : undefined
      }
      if (!factory) return
      const callArguments = path.get('arguments') as NodePath[]
      const definition = callArguments.find(argument => argument.isObjectExpression())
      if (definition?.node.start !== null && definition?.node.start !== undefined) {
        definitions.push(input.offset + definition.node.start)
      }
    } })
  }
  return definitions.length > 1 ? definitions : []
}

/** Out-of-order Options API properties for order-in-components. */
export function componentOrderFindings(descriptor: SFCDescriptor, source: string, configuredOrder?: unknown): ComponentOrderFinding[] {
  const lifecycle = ['beforeCreate', 'created', 'beforeMount', 'mounted', 'beforeUpdate', 'updated',
    'activated', 'deactivated', 'beforeUnmount', 'unmounted', 'beforeDestroy', 'destroyed',
    'renderTracked', 'renderTriggered', 'errorCaptured']
  const router = ['beforeRouteEnter', 'beforeRouteUpdate', 'beforeRouteLeave']
  const defaults: (string | string[])[] = ['el', 'name', 'key', 'parent', 'functional',
    ['delimiters', 'comments'], ['components', 'directives', 'filters'], 'extends', 'mixins',
    ['provide', 'inject'], 'ROUTER_GUARDS', 'layout', 'middleware', 'validate', 'scrollToTop',
    'transition', 'loading', 'inheritAttrs', 'model', ['props', 'propsData'], 'emits', 'slots',
    'expose', 'setup', 'asyncData', 'data', 'fetch', 'head', 'computed', 'watch', 'watchQuery',
    'LIFECYCLE_HOOKS', 'methods', ['template', 'render'], 'renderError']
  const requested = Array.isArray(configuredOrder) ? configuredOrder as (string | string[])[] : defaults
  const order = requested.map(group => group === 'LIFECYCLE_HOOKS' ? lifecycle
    : group === 'ROUTER_GUARDS' ? router : group)
  const positions = new Map<string, number>()
  for (const [index, group] of order.entries()) {
    for (const name of Array.isArray(group) ? group : [group]) positions.set(name, index)
  }
  const findings: ComponentOrderFinding[] = []
  const check = (object: NodePath, offset: number): void => {
    if (!object.isObjectExpression()) return
    const properties = (object.get('properties') as NodePath[]).flatMap(property => {
      const name = componentPropertyName(property)
      const position = name === null ? undefined : positions.get(name)
      return name === null || position === undefined ? [] : [{ property, name, position }]
    })
    for (const [index, current] of properties.entries()) {
      const previous = properties.slice(0, index)
        .filter(candidate => candidate.position > current.position)
        .toSorted((left, right) => left.position - right.position)[0]
      if (previous) findings.push({ name: current.name,
        offset: offset + (current.property.node.start ?? 0) })
    }
  }
  const blocks = [descriptor.script, descriptor.scriptSetup].filter((block): block is NonNullable<typeof block> => Boolean(block))
  const inputs = blocks.length > 0
    ? blocks.map(block => ({ content: block.content, lang: block.lang ?? 'js', offset: block.loc.start.offset }))
    : [{ content: source, lang: 'js', offset: 0 }]
  for (const input of inputs) {
    if (!['js', 'jsx', 'ts', 'tsx'].includes(input.lang)) continue
    let file
    try { file = babelParse(input.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) }
    catch { continue }
    const componentFactories = new Set<object>()
    const seen = new Set<object>()
    traverse(file, { enter(path) {
      let object: NodePath | undefined
      if (path.isVariableDeclarator() && path.get('id').isObjectPattern()
        && path.get('init').isIdentifier({ name: 'Vue' })) {
        for (const property of path.get('id.properties') as NodePath[]) {
          if (!property.isObjectProperty() || staticName(property.node.key) !== 'component') continue
          const value = property.get('value') as NodePath
          if (!value.isIdentifier()) continue
          const binding = property.scope.getBinding(value.node.name)
          if (binding) componentFactories.add(binding)
        }
      }
      if (path.isExportDefaultDeclaration()) object = componentObject(path)
      else if (path.isCallExpression() && path.node.callee.type === 'MemberExpression'
        && staticName(path.node.callee.property) === 'component') {
        object = (path.get('arguments') as NodePath[]).find(argument => argument.isObjectExpression())
      } else if (path.isCallExpression() && path.node.callee.type === 'Identifier'
        && path.node.callee.name === 'defineOptions') {
        const first = (path.get('arguments') as NodePath[])[0]
        if (first?.isObjectExpression()) object = first
      } else if (path.isCallExpression() && path.get('callee').isIdentifier()) {
        const callee = path.get('callee') as NodePath
        const binding = callee.isIdentifier() ? callee.scope.getBinding(callee.node.name) : undefined
        if (binding && componentFactories.has(binding)) {
          object = (path.get('arguments') as NodePath[]).find(argument => argument.isObjectExpression())
        }
      } else if (path.isNewExpression() && path.node.callee.type === 'Identifier'
        && path.node.callee.name === 'Vue') {
        object = (path.get('arguments') as NodePath[]).find(argument => argument.isObjectExpression())
      }
      if (!object || seen.has(object.node)) return
      seen.add(object.node)
      check(object, input.offset)
    } })
  }
  return findings
}

/** Boolean prop defaults rejected by no-boolean-default. */
export function booleanDefaultFindings(descriptor: SFCDescriptor, source: string,
  mode: unknown): BooleanDefaultFinding[] {
  const findings: BooleanDefaultFinding[] = []
  const realBlocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null)
  const blocks = realBlocks.length ? realBlocks.map(block => ({ content: block.content,
    offset: block.loc.start.offset })) : [{ content: source, offset: 0 }]
  for (const block of blocks) {
    let file
    try { file = babelParse(block.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) }
    catch { continue }
    const aliases = new Map<string, AstNode>()
    traverse(file, { enter(path) {
      if (path.isTSTypeAliasDeclaration()) aliases.set(path.node.id.name, path.node.typeAnnotation)
      if (path.isTSInterfaceDeclaration()) aliases.set(path.node.id.name, path.node.body)
    } })
    const report = (value: NodePath, types: string[]): void => {
      if (types.length !== 1 || types[0] !== 'Boolean') return
      while (['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'].includes(value.node.type)) value = value.get('expression') as NodePath
      if (mode === 'default-false' && value.isBooleanLiteral({ value: false })) return
      findings.push({ offset: block.offset + (value.node.start ?? 0) })
    }
    const runtimeDefinitions = (props: NodePath): Map<string, string[]> => {
      const definitions = new Map<string, string[]>()
      if (!props.isObjectExpression()) return definitions
      for (const property of props.get('properties') as NodePath[]) {
        if (!property.isObjectProperty()) continue
        const name = componentPropertyName(property)
        if (name === null) continue
        let config = property.get('value') as NodePath
        while (['TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression'].includes(config.node.type)) config = config.get('expression') as NodePath
        const type = config.isObjectExpression() ? objectPropertyPath(config, 'type') : undefined
        const types = propTypes(type ? pathValue(type) : config)
        definitions.set(name, types)
        const defaultProperty = config.isObjectExpression() ? objectPropertyPath(config, 'default') : undefined
        if (defaultProperty) report(pathValue(defaultProperty), types)
      }
      return definitions
    }
    const typedDefinitions = (call: NodePath): Map<string, string[]> => {
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
    const assignedDefaults = (definitions: Map<string, string[]>, defaults?: NodePath,
      destructure?: NodePath): void => {
      if (defaults?.isObjectExpression()) for (const property of defaults.get('properties') as NodePath[]) {
        if (!property.isObjectProperty() && !property.isObjectMethod()) continue
        const name = componentPropertyName(property)
        if (name !== null) report(pathValue(property), definitions.get(name) ?? [])
      }
      if (destructure?.isObjectPattern()) for (const property of destructure.get('properties') as NodePath[]) {
        if (!property.isObjectProperty()) continue
        const name = staticName(property.node.key)
        const value = property.get('value') as NodePath
        if (name !== null && value.isAssignmentPattern()) report(value.get('right') as NodePath,
          definitions.get(name) ?? [])
      }
    }
    traverse(file, { enter(path) {
      if (path.isExportDefaultDeclaration()) {
        const object = componentObject(path)
        const props = object && objectPropertyPath(object, 'props')
        if (props?.isObjectProperty()) runtimeDefinitions(pathValue(props))
      }
      if (!path.isCallExpression() || path.node.callee.type !== 'Identifier'
        || path.node.callee.name !== 'defineProps') return
      const runtime = (path.get('arguments') as NodePath[])[0]
      const parent = path.parentPath
      const wrapped = parent?.isCallExpression() && parent.node.callee.type === 'Identifier'
        && parent.node.callee.name === 'withDefaults'
      const declarator = (wrapped ? parent.parentPath : parent)?.isVariableDeclarator()
        ? (wrapped ? parent!.parentPath : parent) : undefined
      const defaults = wrapped ? (parent!.get('arguments') as NodePath[])[1] : undefined
      const id = declarator?.isVariableDeclarator() ? declarator.get('id') as NodePath : undefined
      const definitions = runtime ? runtimeDefinitions(runtime) : typedDefinitions(path)
      assignedDefaults(definitions, defaults, id)
    } })
  }
  return findings
}

/** Mis-cased local registration names in an Options API components object. */
export function componentOptionNameFindings(descriptor: SFCDescriptor, source: string,
  casing: unknown): ComponentOptionNameFinding[] {
  const mode = casing === 'camelCase' || casing === 'kebab-case' ? casing : 'PascalCase'
  const matches = (name: string): boolean => mode === 'PascalCase' ? /^[A-Z][A-Za-z0-9]*$/u.test(name)
    : mode === 'camelCase' ? /^[a-z][A-Za-z0-9]*$/u.test(name)
      : /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name)
  const findings: ComponentOptionNameFinding[] = []
  const realBlocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null)
  const blocks = realBlocks.length ? realBlocks.map(block => ({ content: block.content,
    offset: block.loc.start.offset })) : [{ content: source, offset: 0 }]
  for (const block of blocks) {
    let file
    try { file = babelParse(block.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) }
    catch { continue }
    traverse(file, { enter(path) {
      if (!path.isExportDefaultDeclaration()) return
      const object = componentObject(path)
      const components = object && objectPropertyPath(object, 'components')
      const value = components?.isObjectProperty() ? pathValue(components) : undefined
      if (!value?.isObjectExpression()) return
      for (const property of value.get('properties') as NodePath[]) {
        const name = componentPropertyName(property)
        if (name === null || matches(name)) continue
        findings.push({ name, offset: block.offset + (property.node.start ?? 0) })
      }
    } })
  }
  return findings
}

/** Whether component options explicitly disable automatic attribute inheritance. */
export function componentInheritAttrsDisabled(descriptor: SFCDescriptor): boolean {
  let disabled = false
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block || !['js', 'jsx', 'ts', 'tsx'].includes(block.lang ?? 'js')) continue
    let file
    try { file = babelParse(block.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) }
    catch { continue }
    const inspect = (object: NodePath | undefined): void => {
      if (!object) return
      const option = objectPropertyPath(object, 'inheritAttrs')
      if (!option || (!option.isObjectProperty() && !option.isObjectMethod())) return
      disabled ||= staticBooleanValue(pathValue(option)) === false
    }
    traverse(file, { enter(path) {
      if (path.isExportDefaultDeclaration()) inspect(componentObject(path))
      if (path.isCallExpression() && path.node.callee.type === 'Identifier'
        && path.node.callee.name === 'defineOptions') {
        const first = (path.get('arguments') as NodePath[])[0]
        if (first?.isObjectExpression()) inspect(first)
      }
    } })
  }
  return disabled
}

function staticBooleanValue(value: NodePath): boolean | undefined {
  while (['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'].includes(value.node.type)) value = value.get('expression') as NodePath
  if (value.isBooleanLiteral()) return value.node.value
  if (value.isNumericLiteral()) return Boolean(value.node.value)
  if (value.isStringLiteral()) return Boolean(value.node.value)
  if (value.isNullLiteral()) return false
  if (!value.isIdentifier()) return undefined
  const binding = value.scope.getBinding(value.node.name)
  const init = binding?.path.isVariableDeclarator() ? binding.path.get('init') as NodePath : undefined
  return init?.isBooleanLiteral() ? init.node.value : undefined
}

const componentOptionPresets = {
  nuxt: ['asyncData', 'fetch', 'head', 'key', 'layout', 'loading', 'middleware',
    'scrollToTop', 'transition', 'validate', 'watchQuery'],
  'vue-router': ['beforeRouteEnter', 'beforeRouteUpdate', 'beforeRouteLeave'],
  vue: ['data', 'props', 'propsData', 'computed', 'methods', 'watch', 'el', 'template',
    'render', 'renderError', 'staticRenderFns', 'beforeCreate', 'created', 'beforeDestroy',
    'destroyed', 'beforeMount', 'mounted', 'beforeUpdate', 'updated', 'activated',
    'deactivated', 'errorCaptured', 'serverPrefetch', 'directives', 'components',
    'transitions', 'filters', 'provide', 'inject', 'model', 'parent', 'mixins', 'name',
    'extends', 'delimiters', 'comments', 'inheritAttrs', 'setup', 'emits',
    'beforeUnmount', 'unmounted', 'renderTracked', 'renderTriggered'],
} as const

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (const [leftIndex, leftCharacter] of [...left].entries()) {
    const current = [leftIndex + 1]
    for (const [rightIndex, rightCharacter] of [...right].entries()) {
      current.push(Math.min(
        current[rightIndex]! + 1,
        previous[rightIndex + 1]! + 1,
        previous[rightIndex]! + (leftCharacter === rightCharacter ? 0 : 1),
      ))
    }
    previous = current
  }
  return previous.at(-1) ?? 0
}

/** Component option keys close enough to known keys to be probable typos. */
export function componentOptionTypoFindings(descriptor: SFCDescriptor,
  options: Record<string, unknown>): ComponentOptionTypoFinding[] {
  const candidates = new Set<string>()
  if (Array.isArray(options.custom)) for (const value of options.custom) {
    if (typeof value === 'string') candidates.add(value)
  }
  const presets = Array.isArray(options.presets) ? options.presets : ['vue']
  for (const preset of presets) {
    const presetName = String(preset)
    if (presetName === 'all') {
      for (const values of Object.values(componentOptionPresets)) for (const value of values) candidates.add(value)
    } else if (presetName === 'vue' || presetName === 'vue-router' || presetName === 'nuxt') {
      for (const value of componentOptionPresets[presetName]) candidates.add(value)
    }
  }
  const threshold = typeof options.threshold === 'number' ? options.threshold : 1
  const findings: ComponentOptionTypoFinding[] = []
  if (!candidates.size) return findings
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block || !['js', 'jsx', 'ts', 'tsx'].includes(block.lang ?? 'js')) continue
    let file
    try { file = babelParse(block.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) }
    catch { continue }
    traverse(file, { enter(path) {
      if (!path.isExportDefaultDeclaration()) return
      const object = componentObject(path)
      if (!object) return
      for (const property of object.get('properties') as NodePath[]) {
        const name = componentPropertyName(property)
        if (name === null || candidates.has(name)) continue
        const similar = [...candidates].map(candidate => ({
          candidate,
          distance: editDistance(candidate, name),
        })).filter(item => item.distance > 0 && item.distance <= threshold)
          .toSorted((left, right) => left.distance - right.distance)
          .map(item => item.candidate)
        if (similar.length) findings.push({ name, candidates: similar,
          offset: block.loc.start.offset + (property.node.start ?? 0) })
      }
    } })
  }
  return findings
}

function staticString(path: NodePath | undefined): string | null {
  if (!path) return null
  return path.isStringLiteral() ? path.node.value
    : path.isTemplateLiteral() && path.node.expressions.length === 0
      ? path.node.quasis[0]?.value.cooked ?? null : null
}

function memberParts(path: NodePath): { object: NodePath, name: string | null } | undefined {
  while (path.isParenthesizedExpression()) path = path.get('expression') as NodePath
  if (!path.isMemberExpression() && !path.isOptionalMemberExpression()) return undefined
  return { object: path.get('object') as NodePath, name: staticName(path.node.property) }
}

/** Declared and triggered component events for require-explicit-emits. */
export function explicitEmitInfo(descriptor: SFCDescriptor, allowProps: boolean): ExplicitEmitInfo {
  const info: ExplicitEmitInfo = { declared: new Set(), props: new Set(), acceptsAny: false,
    hasDefinition: Boolean(descriptor.scriptSetup), templateEmitters: new Set(['$emit']), findings: [] }
  const typeDeclarations = new Map<string, NodePath>()
  const readDeclarations = (value: NodePath | undefined, target: Set<string>): boolean => {
    if (!value) return false
    while (['TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression'].includes(value.node.type)) value = value.get('expression') as NodePath
    if (value.isArrayExpression()) {
      for (const element of value.get('elements') as NodePath[]) {
        const name = staticString(element)
        if (name === null) return true
        else target.add(name)
      }
    } else if (value.isObjectExpression()) {
      for (const property of value.get('properties') as NodePath[]) {
        const name = componentPropertyName(property)
        if (name === null) return true
        else target.add(name)
      }
    } else return true
    return false
  }
  const readType = (path: NodePath | undefined, target: Set<string>, seen = new Set<object>()): boolean => {
    if (!path || seen.has(path.node)) return true
    seen.add(path.node)
    if (path.isTSTypeReference()) {
      const name = path.get('typeName') as NodePath
      if (!name.isIdentifier()) return true
      const binding = path.scope.getBinding(name.node.name)
      const declaration = binding?.path
      if (declaration?.isTSTypeAliasDeclaration()) return readType(declaration.get('typeAnnotation') as NodePath, target, seen)
      if (declaration?.isTSInterfaceDeclaration()) return readType(declaration.get('body') as NodePath, target, seen)
      const local = typeDeclarations.get(name.node.name)
      if (local?.isTSTypeAliasDeclaration()) return readType(local.get('typeAnnotation') as NodePath, target, seen)
      if (local?.isTSInterfaceDeclaration()) return readType(local.get('body') as NodePath, target, seen)
      return true
    }
    if (path.isTSParenthesizedType()) return readType(path.get('typeAnnotation') as NodePath, target, seen)
    if (path.isTSUnionType()) return (path.get('types') as NodePath[]).some(type => readType(type, target, seen))
    const readEventParameter = (parameter: NodePath | undefined): boolean => {
      if (!parameter) return true
      const annotation = parameter.isIdentifier() ? parameter.get('typeAnnotation') as NodePath : parameter
      const type = annotation?.isTSTypeAnnotation() ? annotation.get('typeAnnotation') as NodePath : annotation
      const literal = type?.isTSLiteralType() ? type.get('literal') as NodePath : undefined
      if (literal?.isStringLiteral()) {
        target.add(literal.node.value)
        return false
      }
      if (type?.isTSUnionType()) return (type.get('types') as NodePath[]).some(member => readEventParameter(member))
      return true
    }
    if (path.isTSFunctionType() || path.isTSCallSignatureDeclaration()) {
      return readEventParameter((path.get('parameters') as NodePath[])[0])
    }
    if (path.isTSTypeLiteral() || path.isTSInterfaceBody()) {
      let dynamic = false
      for (const member of path.get('members') as NodePath[]) {
        if (member.isTSCallSignatureDeclaration()) dynamic ||= readType(member, target, seen)
        else if (member.isTSPropertySignature()) {
          const name = member.node.computed ? staticString(member.get('key') as NodePath)
            : staticName(member.node.key)
          if (name === null) dynamic = true
          else target.add(name)
        }
      }
      return dynamic
    }
    const literal = path.isTSLiteralType() ? path.get('literal') as NodePath : undefined
    if (literal?.isStringLiteral()) {
      target.add(literal.node.value)
      return false
    }
    return true
  }
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block || !['js', 'jsx', 'ts', 'tsx'].includes(block.lang ?? 'js')) continue
    let file
    try { file = babelParse(block.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) }
    catch { continue }
    interface EmitContext { object?: NodePath, declared: Set<string>, props: Set<string>, acceptsAny: boolean }
    const root: EmitContext = { declared: info.declared, props: info.props, acceptsAny: false }
    const emitterBindings = new Map<Binding, EmitContext>()
    const contextBindings = new Map<Binding, EmitContext>()
    const componentObjects: NodePath[] = []
    traverse(file, { enter(path) {
      if ((path.isTSTypeAliasDeclaration() || path.isTSInterfaceDeclaration()) && path.node.id.type === 'Identifier') {
        typeDeclarations.set(path.node.id.name, path)
      }
      if (path.isExportDefaultDeclaration()) {
        const object = componentObject(path)
        if (object) { componentObjects.push(object); root.object = object; info.hasDefinition = true }
      }
      if (!path.isCallExpression() || path.node.callee.type !== 'Identifier'
        || path.node.callee.name !== 'defineEmits') return
      info.hasDefinition = true
      const argument = (path.get('arguments') as NodePath[])[0]
      if (argument) root.acceptsAny ||= readDeclarations(argument, root.declared)
      else {
        const parameters = path.get('typeParameters') as NodePath | undefined
        const type = parameters && (parameters.get('params') as NodePath[])[0]
        root.acceptsAny ||= type ? readType(type, root.declared) : true
      }
      if (path.parentPath?.isVariableDeclarator() && path.parentPath.node.id.type === 'Identifier') {
        const binding = path.scope.getBinding(path.parentPath.node.id.name)
        if (binding) {
          emitterBindings.set(binding, root)
          info.templateEmitters.add(path.parentPath.node.id.name)
        }
      }
    } })
    const rootComponents = componentObjects.slice()
    for (const object of rootComponents) {
      const components = objectPropertyPath(object, 'components')
      const value = components?.isObjectProperty() ? pathValue(components) : undefined
      if (value?.isObjectExpression()) for (const property of value.get('properties') as NodePath[]) {
        if (!property.isObjectProperty()) continue
        const nested = pathValue(property)
        if (nested.isObjectExpression()) componentObjects.push(nested)
      }
    }
    const contexts = new Map<object, EmitContext>()
    for (const object of componentObjects) {
      const context = object === root.object ? root
        : { object, declared: new Set<string>(), props: new Set<string>(), acceptsAny: false }
      contexts.set(object.node, context)
      const emits = objectPropertyPath(object, 'emits')
      if (emits?.isObjectProperty()) context.acceptsAny ||= readDeclarations(pathValue(emits), context.declared)
      if (allowProps) {
        const props = objectPropertyPath(object, 'props')
        if (props?.isObjectProperty()) context.acceptsAny ||= readDeclarations(pathValue(props), context.props)
      }
      const setup = objectPropertyPath(object, 'setup')
      const fn = setup && (setup.isObjectProperty() || setup.isObjectMethod()) ? pathValue(setup) : undefined
      if (fn?.isFunction()) {
        const second = (fn.get('params') as NodePath[])[1]
        if (second?.isIdentifier()) {
          const binding = fn.scope.getBinding(second.node.name)
          if (binding) contextBindings.set(binding, context)
        } else if (second?.isObjectPattern()) for (const property of second.get('properties') as NodePath[]) {
          if (!property.isObjectProperty() || staticName(property.node.key) !== 'emit') continue
          const value = property.get('value') as NodePath
          if (value.isIdentifier()) {
            const binding = value.scope.getBinding(value.node.name)
            if (binding) emitterBindings.set(binding, context)
          }
        }
      }
    }
    if (allowProps) traverse(file, { enter(path) {
      if (!path.isCallExpression()) return
      if (path.node.callee.type !== 'Identifier' || path.node.callee.name !== 'defineProps') return
      const argument = (path.get('arguments') as NodePath[])[0]
      if (argument) root.acceptsAny ||= readDeclarations(argument, root.props)
      else {
        const parameters = path.get('typeParameters') as NodePath | undefined
        const type = parameters && (parameters.get('params') as NodePath[])[0]
        root.acceptsAny ||= type ? readType(type, root.props) : true
      }
    } })
    const nearestContext = (path: NodePath): EmitContext | undefined => {
      const owner = path.findParent(parent => parent.isObjectExpression() && contexts.has(parent.node))
      return owner ? contexts.get(owner.node) : undefined
    }
    traverse(file, { enter(path) {
      if (!path.isCallExpression() && !path.isOptionalCallExpression()) return
      const first = (path.get('arguments') as NodePath[])[0]
      const name = staticString(first)
      if (name === null) return
      let callee = path.get('callee') as NodePath
      while (callee.isParenthesizedExpression()) callee = callee.get('expression') as NodePath
      let context: EmitContext | undefined
      if (callee.isIdentifier()) {
        const binding = callee.scope.getBinding(callee.node.name)
        context = binding ? emitterBindings.get(binding) : undefined
      } else {
        const member = memberParts(callee)
        const receiver = member?.object
        if (member?.name === '$emit' && receiver) {
          if (receiver.isThisExpression()) context = nearestContext(path)
          else if (receiver.isIdentifier()) {
            const binding = receiver.scope.getBinding(receiver.node.name)
            const init = binding?.path.isVariableDeclarator() ? binding.path.get('init') as NodePath : undefined
            if (binding && init?.isThisExpression()) context = nearestContext(binding.path)
          }
        }
        if (member?.name === 'emit' && receiver?.isIdentifier()) {
          const binding = receiver.scope.getBinding(receiver.node.name)
          context = binding ? contextBindings.get(binding) : undefined
        }
      }
      if (context && !context.acceptsAny && !context.declared.has(name)
        && !(allowProps && context.props.has(`on${name.charAt(0).toUpperCase()}${name.slice(1)}`))) {
        info.findings.push({ name, offset: block.loc.start.offset + (first?.node.start ?? 0) })
      }
    } })
    info.acceptsAny ||= root.acceptsAny
  }
  return info
}

/** Names exposed by Options API groups to the component template. */
export function componentPublicNames(descriptor: SFCDescriptor): Set<string> {
  const names = new Set<string>()
  for (const block of [descriptor.script]) {
    if (!block || !['js', 'jsx', 'ts', 'tsx'].includes(block.lang ?? 'js')) continue
    let file
    try { file = babelParse(block.content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'] }) }
    catch { continue }
    traverse(file, { enter(path) {
      if (!path.isExportDefaultDeclaration()) return
      const object = componentObject(path)
      if (!object) return
      for (const groupName of ['props', 'computed', 'methods']) {
        const group = objectPropertyPath(object, groupName)
        const value = group?.isObjectProperty() ? pathValue(group) : undefined
        if (!value?.isObjectExpression()) continue
        for (const property of value.get('properties') as NodePath[]) {
          const name = componentPropertyName(property)
          if (name !== null) names.add(name)
        }
      }
      for (const groupName of ['data', 'asyncData', 'setup']) {
        const group = objectPropertyPath(object, groupName)
        const fn = group && (group.isObjectProperty() || group.isObjectMethod()) ? pathValue(group) : undefined
        if (fn?.isObjectExpression()) {
          for (const property of fn.get('properties') as NodePath[]) {
            const name = componentPropertyName(property)
            if (name !== null) names.add(name)
          }
          continue
        }
        if (!fn?.isFunction()) continue
        fn.traverse({ ReturnStatement(returnPath) {
          if (returnPath.getFunctionParent() !== fn) return
          const value = returnPath.get('argument') as NodePath
          if (!value?.isObjectExpression()) return
          for (const property of value.get('properties') as NodePath[]) {
            const name = componentPropertyName(property)
            if (name !== null) names.add(name)
          }
        } })
        if (fn.isArrowFunctionExpression() && fn.get('body').isObjectExpression()) {
          for (const property of (fn.get('body') as NodePath).get('properties') as NodePath[]) {
            const name = componentPropertyName(property)
            if (name !== null) names.add(name)
          }
        }
      }
    } })
  }
  return names
}

const nativePropTypes = new Set(['String', 'Number', 'Boolean', 'Function', 'Object', 'Array', 'Symbol', 'BigInt'])

function objectPropertyPath(object: NodePath, name: string): NodePath | undefined {
  if (!object.isObjectExpression()) return undefined
  return (object.get('properties') as NodePath[]).find(property =>
    (property.isObjectProperty() || property.isObjectMethod()) && !property.node.computed
    && staticName(property.node.key) === name)
}

function componentPropertyName(path: NodePath): string | null {
  if (!path.isObjectProperty() && !path.isObjectMethod()) return null
  const key = path.node.key
  if (!path.node.computed) return staticName(key)
  if (key.type === 'StringLiteral') return key.value
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0) return key.quasis[0]?.value.cooked ?? null
  return null
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
