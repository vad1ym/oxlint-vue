/**
 * Parse the JSON-with-comments dialect oxlint accepts.
 *
 * Comment stripping MUST be string-aware. A naive `/\/\*[\s\S]*?\*\//` sweep
 * over a config containing glob patterns treats the `/**", "**\/` between two
 * ignorePatterns entries as a block comment and deletes the text between them,
 * silently merging two patterns into one nonsensical pattern.
 */
export function parseJsonc<T = unknown>(text: string): T {
  let out = ''
  let quote: string | null = null

  for (let i = 0; i < text.length; i++) {
    const c = text[i]

    if (quote) {
      out += c
      if (c === '\\') { out += text[++i] ?? ''; continue }
      if (c === quote) quote = null
      continue
    }

    if (c === '"' || c === '\'') { quote = c; out += c; continue }

    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }

    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }

    out += c
  }

  // Trailing commas are legal in oxlint's config but not in JSON.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as T
}
