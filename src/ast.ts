import type { DirectiveNode } from '@vue/compiler-core'
import { NodeTypes, extractIdentifiers, walkIdentifiers } from '@vue/compiler-core'
import { babelParse } from '@vue/compiler-sfc'

export type AstNode = Parameters<typeof walkIdentifiers>[0]

/** Parse expressions independently of compiler-sfc's optional AST cache. */
export function expressionAst(exp: DirectiveNode['exp']): AstNode | null {
  if (!exp || exp.type !== NodeTypes.SIMPLE_EXPRESSION || !exp.content.trim()) return null
  try {
    const statement = babelParse(`(${exp.content})`, { plugins: ['typescript'] }).program.body[0]
    return statement?.type === 'ExpressionStatement' ? statement.expression : null
  } catch {
    // Inline event handlers may contain several statements.
    try { return babelParse(exp.content, { plugins: ['typescript'] }).program } catch { return null }
  }
}

export function bindingNames(exp: DirectiveNode['exp']): string[] {
  if (!exp || exp.type !== NodeTypes.SIMPLE_EXPRESSION) return []
  try {
    const statement = babelParse(`(${exp.content})=>{}`, { plugins: ['typescript'] }).program.body[0]
    if (statement?.type !== 'ExpressionStatement' || statement.expression.type !== 'ArrowFunctionExpression') return []
    return statement.expression.params.flatMap(param => extractIdentifiers(param).map(id => id.name))
  } catch { return [] }
}

/** Ignore source spelling/locations, but retain literal values and operators. */
export function expressionKey(exp: DirectiveNode['exp']): string | null {
  const ast = expressionAst(exp)
  if (!ast || ast.type === 'Program') return null
  return JSON.stringify(ast, (key, value: unknown) =>
    ['start', 'end', 'loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'errors'].includes(key)
      ? undefined
      : value)
}

export function unwrap(node: AstNode): AstNode {
  while (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion'
    || node.type === 'TSNonNullExpression' || node.type === 'TSSatisfiesExpression'
    || node.type === 'ParenthesizedExpression') node = node.expression
  return node
}

export function staticName(node: AstNode): string | null {
  return node.type === 'Identifier' ? node.name : node.type === 'StringLiteral' ? node.value : null
}
