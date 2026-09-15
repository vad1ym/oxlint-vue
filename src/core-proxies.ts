/** eslint-plugin-vue rules that directly proxy an oxlint core rule. */
export const coreProxyRules = {
  eqeqeq: 'eqeqeq',
  'no-empty-pattern': 'no-empty-pattern',
  'no-implicit-coercion': 'no-implicit-coercion',
  'no-console': 'no-console',
  'no-constant-condition': 'no-constant-condition',
  'no-loss-of-precision': 'no-loss-of-precision',
  'no-negated-condition': 'no-negated-condition',
  'no-sparse-arrays': 'no-sparse-arrays',
  'no-useless-concat': 'no-useless-concat',
  'object-shorthand': 'object-shorthand',
  'prefer-template': 'prefer-template',
} as const

/** Utility rules whose compatibility behavior is supplied by preprocessing plus oxlint. */
export const nativeUtilityRules = {
  'jsx-uses-vars': 'oxlint JSX reference tracking',
  'no-unused-vars': 'virtual template and CSS reference tracking plus oxlint no-unused-vars',
} as const

export type CoreProxyName = keyof typeof coreProxyRules
