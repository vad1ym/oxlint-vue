import type { SFCDescriptor } from '@vue/compiler-sfc'

/**
 * A single finding, in the shape every source produces and every reporter
 * consumes. Positions are 1-based and refer to the ORIGINAL `.vue` file --
 * the padding transform preserves offsets, so no source is ever reporting
 * against the virtual file.
 */
export interface Diagnostic {
  filename: string
  line: number
  column: number
  severity: 'error' | 'warning'
  /** `eslint(no-unused-vars)` from oxlint, or `vue/require-v-for-key` from us. */
  rule: string
  message: string
  help?: string
  /** Byte offset, when the producer knows it. */
  offset?: number
}

/** Result of turning one `.vue` file into its padded virtual counterpart. */
export interface PreprocessResult {
  /** Virtual TypeScript, byte-for-byte the same length as the input. */
  code: string
  descriptor: SFCDescriptor
  parseErrors: { message: string, offset: number }[]
  hasScript: boolean
}

/**
 * Severity as it may be spelled in an oxlint config. Accepting every form
 * means one `.oxlintrc.json` configures both halves of the tool.
 */
export type RuleSeverity
  = | 'off' | 'warn' | 'warning' | 'error' | 'deny' | 'allow'
    | 0 | 1 | 2 | boolean

export type RuleConfig = RuleSeverity | [RuleSeverity, ...unknown[]]

/** The `rules` map of an oxlint config, plus our own under `settings`. */
export type RulesMap = Record<string, RuleConfig>

/** The subset of an oxlint config this tool reads. */
export interface OxlintConfig {
  extends?: string[]
  rules?: RulesMap
  ignorePatterns?: string[]
  settings?: {
    vue?: { rules?: RulesMap }
  }
}

/** The subset of an oxfmt config this tool reads. */
export interface OxfmtConfig {
  extends?: string[]
  ignorePatterns?: string[]
}

/** oxlint's `--format=json` output. */
export interface OxlintJsonOutput {
  diagnostics?: OxlintJsonDiagnostic[]
  results?: OxlintJsonDiagnostic[]
}

export interface OxlintJsonDiagnostic {
  message?: string
  code?: string
  ruleId?: string
  rule?: string
  severity?: string
  help?: string
  filename?: string
  fileName?: string
  path?: string
  file?: string
  line?: number
  column?: number
  offset?: number
  span?: OxlintSpan
  labels?: { label?: string, span?: OxlintSpan }[]
}

export interface OxlintSpan {
  offset?: number
  length?: number
  line?: number
  column?: number
}
