import type { Diagnostic, PreprocessResult } from './types.js'

/** Shared by CLI and LSP so incomplete checking cannot disappear in the editor. */
export function preprocessingDiagnostics(
  result: PreprocessResult,
  filename: string,
  source: string,
  strictTemplates = false,
): Diagnostic[] {
  return [
    ...result.parseErrors.map(error => ({ ...error, rule: 'vue/no-parsing-error', severity: 'error' as const })),
    ...result.coverageGaps.map(gap => ({ ...gap, rule: 'oxlint-vue/incomplete-template',
      severity: strictTemplates ? 'error' as const : 'warning' as const })),
  ].map(item => {
    const prefix = source.slice(0, item.offset)
    const line = prefix.split('\n').length
    const column = prefix.length - prefix.lastIndexOf('\n')
    return { filename, line, column, offset: Buffer.byteLength(prefix),
      severity: item.severity, rule: item.rule, message: item.message }
  })
}
