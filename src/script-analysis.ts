import { isGloballyAllowed } from '@vue/shared'
import { extractIdentifiers } from '@vue/compiler-core'
import { babelParse } from '@vue/compiler-sfc'
import { staticName, unwrap } from './ast.js'
import type { AstNode } from './ast.js'

export interface ScriptAnalysis {
  props: Map<string, string>
  propObjects: Set<string>
  arrays: Set<string>
}

/** Resolve local syntax only; imported type members require a type checker. */
export function analyzeScript(source: string | undefined): ScriptAnalysis {
  const result: ScriptAnalysis = { props: new Map(), propObjects: new Set(), arrays: new Set() }
  if (!source) return result
  let program
  try { program = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'decorators-legacy'] }).program } catch { return result }
  const names = new Set<string>()
  const declared = new Set<string>()
  const types = new Map<string, AstNode>()
  const statements = program.body.map(stmt => stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt).filter(stmt => stmt != null)
  for (const stmt of statements) {
    if (stmt.type === 'TSInterfaceDeclaration') types.set(stmt.id.name, stmt.body)
    if (stmt.type === 'TSTypeAliasDeclaration') types.set(stmt.id.name, stmt.typeAnnotation)
  }
  const collectType = (node: AstNode, seen = new Set<string>()): void => {
    if (node.type === 'TSTypeReference' && node.typeName.type === 'Identifier') {
      const name = node.typeName.name
      if (seen.has(name)) return
      seen.add(name)
      const type = types.get(name)
      if (type) collectType(type, seen)
    } else if (node.type === 'TSIntersectionType' || node.type === 'TSUnionType') {
      for (const type of node.types) collectType(type, seen)
    } else if (node.type === 'TSInterfaceBody' || node.type === 'TSTypeLiteral') {
      const members = node.type === 'TSInterfaceBody' ? node.body : node.members
      for (const member of members) {
        if (member.type !== 'TSPropertySignature' || member.computed) continue
        const name = staticName(member.key)
        if (name) names.add(name)
      }
    }
  }
  const macro = (node: AstNode): boolean => {
    node = unwrap(node)
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return false
    if (node.callee.name === 'withDefaults') {
      const first = node.arguments[0]
      return !!first && first.type !== 'ArgumentPlaceholder' && macro(first)
    }
    if (node.callee.name !== 'defineProps') return false
    for (const type of node.typeParameters?.params ?? []) collectType(type)
    const arg = node.arguments[0]
    if (arg?.type === 'ObjectExpression') {
      for (const prop of arg.properties) {
        if (prop.type === 'SpreadElement' || prop.computed) continue
        const name = staticName(prop.key)
        if (name) names.add(name)
      }
    } else if (arg?.type === 'ArrayExpression') {
      for (const value of arg.elements) if (value?.type === 'StringLiteral') names.add(value.value)
    }
    return true
  }
  for (const stmt of statements) {
    if (stmt.type === 'ImportDeclaration') {
      for (const specifier of stmt.specifiers) declared.add(specifier.local.name)
    } else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) {
      declared.add(stmt.id.name)
    } else if (stmt.type === 'ExpressionStatement') macro(stmt.expression)
    else if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        for (const id of extractIdentifiers(decl.id)) declared.add(id.name)
        if (!decl.init) continue
        const init = unwrap(decl.init)
        if (stmt.kind === 'const' && decl.id.type === 'Identifier' && init.type === 'ArrayExpression') result.arrays.add(decl.id.name)
        if (!macro(init)) continue
        if (decl.id.type === 'Identifier') result.propObjects.add(decl.id.name)
        if (decl.id.type === 'ObjectPattern') {
          for (const prop of decl.id.properties) {
            if (prop.type === 'RestElement') {
              for (const id of extractIdentifiers(prop.argument)) result.propObjects.add(id.name)
            } else if (!prop.computed) {
              const name = staticName(prop.key)
              if (name) for (const id of extractIdentifiers(prop.value)) result.props.set(id.name, name)
            }
          }
        }
      }
    }
  }
  for (const name of names) if (!declared.has(name) && !isGloballyAllowed(name)) result.props.set(name, name)
  return result
}
