import type { DirectiveNode, RootNode, TemplateChildNode } from '@vue/compiler-core'
import type { SFCDescriptor } from '@vue/compiler-sfc'
import { NodeTypes, extractIdentifiers, walkIdentifiers } from '@vue/compiler-core'
import { babelParse } from '@vue/compiler-sfc'

/** Declaration ranges whose bindings Vue consumes outside the script. */
export interface UsedBinding { start: number, end: number }

type Expression = DirectiveNode['exp']

function localBindingNames(exp: Expression): string[] {
  if (!exp || exp.type !== NodeTypes.SIMPLE_EXPRESSION) return []
  const ast = babelParse(`(${exp.content})=>{}`, { plugins: ['typescript'] })
  const stmt = ast.program.body[0]
  if (stmt?.type !== 'ExpressionStatement' || stmt.expression.type !== 'ArrowFunctionExpression') return []
  return stmt.expression.params.flatMap(param => extractIdentifiers(param).map(id => id.name))
}

/**
 * Equivalent to marking a script-setup variable used in an ESLint parser.
 * Resolve template locals before collecting free names, then match only actual
 * top-level declarations. A nested function's same-named variable stays unused.
 */
export function templateUsedBindings(descriptor: SFCDescriptor): UsedBinding[] {
  const script = descriptor.scriptSetup
  if (!script) return []
  const used = new Set<string>()
  const references = (exp: Expression, locals: Set<string>): void => {
    if (!exp || exp.type !== NodeTypes.SIMPLE_EXPRESSION || exp.isStatic) return
    if (exp.ast) {
      walkIdentifiers(exp.ast, id => { if (!locals.has(id.name)) used.add(id.name) })
    } else if (exp.ast === null) {
      if (!locals.has(exp.content)) used.add(exp.content)
    }
  }
  function visit(node: RootNode | TemplateChildNode, inherited: Set<string>): void {
    if (node.type === NodeTypes.INTERPOLATION) references(node.content, inherited)
    if (node.type === NodeTypes.ELEMENT) {
      const locals = new Set(inherited)
      for (const prop of node.props) {
        if (prop.type !== NodeTypes.DIRECTIVE || prop.name !== 'for') continue
        const loop = prop.forParseResult
        if (!loop) continue
        references(loop.source, inherited)
        for (const exp of [loop.value, loop.key, loop.index]) {
          for (const name of localBindingNames(exp)) locals.add(name)
        }
      }
      for (const prop of node.props) {
        if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'slot') {
          for (const name of localBindingNames(prop.exp)) locals.add(name)
        }
      }
      for (const prop of node.props) {
        if (prop.type !== NodeTypes.DIRECTIVE || prop.name === 'for' || prop.name === 'slot') continue
        // v-if has priority over v-for and cannot see its aliases.
        references(prop.exp, prop.name === 'if' ? inherited : locals)
        references(prop.arg, locals)
      }
      for (const child of node.children) visit(child, locals)
    } else if (node.type === NodeTypes.ROOT) {
      for (const child of node.children) visit(child, inherited)
    }
  }
  if (descriptor.template?.ast) visit(descriptor.template.ast, new Set())
  for (const expression of descriptor.cssVars) {
    const ast = babelParse(`(${expression})`, { plugins: ['typescript'] })
    walkIdentifiers(ast.program, id => used.add(id.name))
  }

  const ast = babelParse(script.content, { sourceType: 'module', plugins: ['typescript', 'decorators-legacy', ...(script.lang === 'tsx' || script.lang === 'jsx' ? ['jsx' as const] : [])] })
  const result: UsedBinding[] = []
  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (!declaration) continue
    const identifiers = declaration.type === 'ImportDeclaration'
      ? declaration.specifiers.map(specifier => specifier.local)
      : declaration.type === 'VariableDeclaration'
        ? declaration.declarations.flatMap(decl => extractIdentifiers(decl.id))
        : (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id
          ? [declaration.id]
          : []
    for (const id of identifiers) {
      if (used.has(id.name) && id.start != null && id.end != null) {
        result.push({ start: script.loc.start.offset + id.start, end: script.loc.start.offset + id.end })
      }
    }
  }
  return result
}

/** Match the declaration location, never the diagnostic's human-readable text. */
export function isTemplateUsedBinding(
  code: string,
  bindings: UsedBinding[],
  line: number,
  column: number,
  utf16 = false,
): boolean {
  const lines = code.split('\n')
  const text = lines[line - 1] ?? ''
  const prefix = utf16 ? text.slice(0, column - 1) : Buffer.from(text).subarray(0, column - 1).toString()
  const offset = lines.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0) + prefix.length
  return bindings.some(binding => offset >= binding.start && offset < binding.end)
}
