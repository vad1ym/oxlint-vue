# Editor setup

Nothing extra to install: the language server ships with the package. You
point your editor at it and it does the rest -- `oxlint-vue --lsp` is the
command the editor runs, not one you type.

It is a **superset, not a replacement**: a real `oxlint --lsp` runs inside it,
`.ts`/`.js` and every protocol method pass through untouched, and `.vue` goes
down as the virtual file.

**Zed** — install the **Oxc** extension, then point it at the proxy:

```json
{
  "lsp": {
    "oxlint": {
      "binary": { "path": "npx", "arguments": ["oxlint-vue", "--lsp"] }
    }
  }
}
```

The Oxc extension is already bound to `Vue.js`, so no custom extension is
needed. Volar keeps working alongside it — types and navigation from Volar,
lint from here; the diagnostic codes do not overlap.

**Neovim:**

```lua
vim.lsp.config.oxlint-vue = {
  cmd = { 'npx', 'oxlint-vue', '--lsp' },
  filetypes = { 'vue', 'typescript', 'javascript' },
  root_markers = { '.oxlintrc.json', 'package.json' },
}
vim.lsp.enable('oxlint-vue')
```

**VS Code** — needs a thin `vscode-languageclient` wrapper; no extension yet.
