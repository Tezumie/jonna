// Extensions recommended for the open workspace (VS Code's "Recommended" section): the ones a
// folder's `.vscode/extensions.json` names, and well-known Open VSX extensions for the kinds of
// files in the workspace and the open editors. Every id below was checked to exist on Open VSX
// (https://open-vsx.org/api/{namespace}/{name}) when it was added. DOM-free and tested.

import { parseJsonc } from "../settings/jsonc";

export interface Recommendation {
  /** `namespace.name` as Open VSX writes it (installed ids compare without regard to case). */
  id: string;
  /** Why, in a few words ("Recommended by this workspace", "For Python files"). */
  reason: string;
  source: "workspace" | "files" | "popular";
}

/**
 * Shown when nothing else is recommended (no folder open, or nothing to suggest for it), so the
 * whole Open VSX store is plain to see, not only the IDE's own extensions (D406): widely used
 * extensions the IDE runs (docs/extensions.md's table), checked on Open VSX in Nov 2026.
 */
export const POPULAR_EXTENSIONS: readonly string[] = [
  "esbenp.prettier-vscode",
  "dbaeumer.vscode-eslint",
  "ms-python.python",
  "usernamehw.errorlens",
  "christian-kohler.path-intellisense",
];

/** What a folder's extensions.json says: ids to recommend, and ids it doesn't want. */
export interface WorkspaceRecommendations {
  recommendations: string[];
  unwanted: string[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_WORKSPACE = 40;

/** `.vscode/extensions.json` (JSONC): `recommendations` and `unwantedRecommendations`. */
export function parseExtensionsJson(text: string): WorkspaceRecommendations {
  const parsed = parseJsonc(text);
  const value = parsed.ok ? parsed.value : null;
  const x = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const ids = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => ID.test(s))
      .slice(0, MAX_WORKSPACE);
  const r = x as Record<string, unknown>;
  return { recommendations: ids(r.recommendations), unwanted: ids(r.unwantedRecommendations) };
}

interface Rule {
  id: string;
  /** "Python": the reason reads "For Python files". */
  what: string;
}

/** By file extension (lowercase, without the dot). */
const BY_EXTENSION: Record<string, Rule> = {
  py: { id: "ms-python.python", what: "Python" },
  pyi: { id: "ms-python.python", what: "Python" },
  ipynb: { id: "ms-toolsai.jupyter", what: "Jupyter notebook" },
  go: { id: "golang.Go", what: "Go" },
  rs: { id: "rust-lang.rust-analyzer", what: "Rust" },
  java: { id: "redhat.java", what: "Java" },
  cs: { id: "muhammad-sammy.csharp", what: "C#" },
  csproj: { id: "muhammad-sammy.csharp", what: "C#" },
  php: { id: "bmewburn.vscode-intelephense-client", what: "PHP" },
  rb: { id: "Shopify.ruby-lsp", what: "Ruby" },
  dart: { id: "Dart-Code.dart-code", what: "Dart" },
  vue: { id: "Vue.volar", what: "Vue" },
  svelte: { id: "svelte.svelte-vscode", what: "Svelte" },
  astro: { id: "astro-build.astro-vscode", what: "Astro" },
  tf: { id: "hashicorp.terraform", what: "Terraform" },
  tfvars: { id: "hashicorp.terraform", what: "Terraform" },
  md: { id: "yzhang.markdown-all-in-one", what: "Markdown" },
  kt: { id: "fwcd.kotlin", what: "Kotlin" },
  kts: { id: "fwcd.kotlin", what: "Kotlin" },
  swift: { id: "swiftlang.swift-vscode", what: "Swift" },
  c: { id: "llvm-vs-code-extensions.vscode-clangd", what: "C" },
  h: { id: "llvm-vs-code-extensions.vscode-clangd", what: "C" },
  cpp: { id: "llvm-vs-code-extensions.vscode-clangd", what: "C++" },
  cc: { id: "llvm-vs-code-extensions.vscode-clangd", what: "C++" },
  cxx: { id: "llvm-vs-code-extensions.vscode-clangd", what: "C++" },
  hpp: { id: "llvm-vs-code-extensions.vscode-clangd", what: "C++" },
  lua: { id: "sumneko.lua", what: "Lua" },
  zig: { id: "ziglang.vscode-zig", what: "Zig" },
  ex: { id: "elixir-lsp.elixir-ls", what: "Elixir" },
  exs: { id: "elixir-lsp.elixir-ls", what: "Elixir" },
  hs: { id: "haskell.haskell", what: "Haskell" },
  scala: { id: "scalameta.metals", what: "Scala" },
  sc: { id: "scalameta.metals", what: "Scala" },
  toml: { id: "tamasfe.even-better-toml", what: "TOML" },
  yaml: { id: "redhat.vscode-yaml", what: "YAML" },
  yml: { id: "redhat.vscode-yaml", what: "YAML" },
  xml: { id: "redhat.vscode-xml", what: "XML" },
  prisma: { id: "Prisma.prisma", what: "Prisma" },
  graphql: { id: "GraphQL.vscode-graphql", what: "GraphQL" },
  gql: { id: "GraphQL.vscode-graphql", what: "GraphQL" },
  nix: { id: "jnoortheen.nix-ide", what: "Nix" },
  proto: { id: "zxh404.vscode-proto3", what: "Protocol Buffers" },
  ml: { id: "ocamllabs.ocaml-platform", what: "OCaml" },
  mli: { id: "ocamllabs.ocaml-platform", what: "OCaml" },
  jl: { id: "julialang.language-julia", what: "Julia" },
  r: { id: "REditorSupport.r", what: "R" },
  tex: { id: "James-Yu.latex-workshop", what: "LaTeX" },
  ps1: { id: "ms-vscode.PowerShell", what: "PowerShell" },
  psm1: { id: "ms-vscode.PowerShell", what: "PowerShell" },
  sh: { id: "timonwong.shellcheck", what: "shell script" },
  gd: { id: "geequlim.godot-tools", what: "GDScript" },
  csv: { id: "mechatroner.rainbow-csv", what: "CSV" },
};

/** By file name (lowercase): tools' own files. */
const BY_NAME: Record<string, Rule> = {
  dockerfile: { id: "ms-azuretools.vscode-docker", what: "Docker" },
  "docker-compose.yml": { id: "ms-azuretools.vscode-docker", what: "Docker" },
  "docker-compose.yaml": { id: "ms-azuretools.vscode-docker", what: "Docker" },
  "compose.yml": { id: "ms-azuretools.vscode-docker", what: "Docker" },
  "compose.yaml": { id: "ms-azuretools.vscode-docker", what: "Docker" },
  "pubspec.yaml": { id: "Dart-Code.flutter", what: "Flutter" },
  "cmakelists.txt": { id: "ms-vscode.cmake-tools", what: "CMake" },
  ".editorconfig": { id: "EditorConfig.EditorConfig", what: "EditorConfig" },
  "deno.json": { id: "denoland.vscode-deno", what: "Deno" },
  "deno.jsonc": { id: "denoland.vscode-deno", what: "Deno" },
  "biome.json": { id: "biomejs.biome", what: "Biome" },
  "biome.jsonc": { id: "biomejs.biome", what: "Biome" },
};

/** By a pattern on the file name: config files that come in many spellings. */
const BY_PATTERN: [RegExp, Rule][] = [
  [/^dockerfile\..+$|^.+\.dockerfile$/, { id: "ms-azuretools.vscode-docker", what: "Docker" }],
  [
    /^\.prettierrc(\..+)?$|^prettier\.config\.[cm]?[jt]s$/,
    { id: "esbenp.prettier-vscode", what: "Prettier" },
  ],
  [
    /^\.eslintrc(\..+)?$|^eslint\.config\.[cm]?[jt]s$/,
    { id: "dbaeumer.vscode-eslint", what: "ESLint" },
  ],
  [/^tailwind\.config\.[cm]?[jt]s$/, { id: "bradlc.vscode-tailwindcss", what: "Tailwind CSS" }],
  [
    /^\.stylelintrc(\..+)?$|^stylelint\.config\.[cm]?[jt]s$/,
    { id: "stylelint.vscode-stylelint", what: "Stylelint" },
  ],
];

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The rule a file matches, if any. */
function ruleFor(path: string): Rule | undefined {
  const name = baseName(path).toLowerCase();
  if (!name) return undefined;
  const named = BY_NAME[name];
  if (named) return named;
  for (const [pattern, rule] of BY_PATTERN) if (pattern.test(name)) return rule;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] : undefined;
}

/** Recommendations for these files (each id once, in the files' order). */
export function fileRecommendations(paths: readonly string[]): Recommendation[] {
  const out = new Map<string, Recommendation>();
  for (const path of paths) {
    const rule = ruleFor(path);
    if (!rule || out.has(rule.id.toLowerCase())) continue;
    out.set(rule.id.toLowerCase(), {
      id: rule.id,
      reason: `For ${rule.what} files`,
      source: "files",
    });
  }
  return [...out.values()];
}

/**
 * What the Recommended section lists: the workspace's own recommendations first, then the
 * files' — without installed or ignored ones, nor ones a folder marks unwanted. Ids compare
 * without regard to case (Open VSX resolves them so).
 */
export function recommendationsFor(input: {
  workspace: readonly WorkspaceRecommendations[];
  paths: readonly string[];
  installed: ReadonlySet<string>;
  ignored: readonly string[];
}): Recommendation[] {
  const skip = new Set([
    ...[...input.installed].map((s) => s.toLowerCase()),
    ...input.ignored.map((s) => s.toLowerCase()),
    ...input.workspace.flatMap((w) => w.unwanted.map((s) => s.toLowerCase())),
  ]);
  const out = new Map<string, Recommendation>();
  const add = (r: Recommendation) => {
    const key = r.id.toLowerCase();
    if (!skip.has(key) && !out.has(key)) out.set(key, r);
  };
  for (const w of input.workspace)
    for (const id of w.recommendations)
      add({ id, reason: "Recommended by this workspace", source: "workspace" });
  for (const r of fileRecommendations(input.paths)) add(r);
  if (!out.size)
    for (const id of POPULAR_EXTENSIONS) add({ id, reason: "Popular", source: "popular" });
  return [...out.values()];
}
