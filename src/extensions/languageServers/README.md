# extensions/languageServers

Declarative built-in extension: `contributes.languageServers` for 17 servers (D199): TypeScript and
JavaScript (typescript-language-server), Pyright, rust-analyzer, gopls, clangd, csharp-ls, Eclipse
JDT, Intelephense, Ruby LSP, lua-language-server, bash, YAML, Taplo, Dockerfile, Svelte, ZLS and
Kotlin. Each has a `title`, a `description` and `install` methods. Nothing runs unless you open a
file of that language; a missing server is offered for install (see `extensions/lsp`). When the
TypeScript server runs, Monaco's own TypeScript service is turned off for the languages it covers,
so there's one source of completions and problems. Third-party extensions can't contribute
language servers yet; other servers go in the user's `lsp.servers` setting.
