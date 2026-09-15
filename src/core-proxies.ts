/** eslint-plugin-vue rules that directly proxy an oxlint core rule. */
export const coreProxyRules = {
  eqeqeq: 'eqeqeq',
  'no-console': 'no-console',
  'no-constant-condition': 'no-constant-condition',
  'no-loss-of-precision': 'no-loss-of-precision',
  'no-negated-condition': 'no-negated-condition',
  'no-sparse-arrays': 'no-sparse-arrays',
  'no-useless-concat': 'no-useless-concat',
  'object-shorthand': 'object-shorthand',
  'prefer-template': 'prefer-template',
} as const

export type CoreProxyName = keyof typeof coreProxyRules
