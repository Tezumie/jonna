// File icon themes in VS Code's format (D132): `iconDefinitions` plus the maps that pick one for
// a file (file names, extensions, language ids) or a folder (names, root folders, expanded), with
// `light` / `highContrast` overrides. Any VS Code icon theme extension's JSON works as is. This
// module only resolves names to definition ids; loading the images is the workbench's job.
// DOM-free.

export interface IconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
}

interface IconMaps {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  rootFolder?: string;
  rootFolderExpanded?: string;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  rootFolderNames?: Record<string, string>;
  rootFolderNamesExpanded?: Record<string, string>;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
}

export interface IconThemeDocument extends IconMaps {
  iconDefinitions: Record<string, IconDefinition>;
  light?: IconMaps;
  highContrast?: IconMaps;
  hidesExplorerArrows?: boolean;
  fonts?: {
    id: string;
    src: { path: string; format: string }[];
    weight?: string;
    style?: string;
    size?: string;
  }[];
}

export interface IconQuery {
  name: string;
  kind: "file" | "folder";
  expanded?: boolean;
  /** The workspace folder itself. */
  root?: boolean;
  /** The file's language (when no name or extension rule matched). */
  languageId?: string;
  light?: boolean;
}

const lower = (m: Record<string, string> | undefined) =>
  m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k.toLowerCase(), v])) : undefined;

/** Lower-cased lookups, the light variant merged over the base (VS Code's precedence). */
export class IconTheme {
  readonly hidesExplorerArrows: boolean;
  private readonly dark: IconMaps;
  private readonly lightMaps: IconMaps;

  constructor(readonly doc: IconThemeDocument) {
    this.hidesExplorerArrows = doc.hidesExplorerArrows === true;
    this.dark = normalize(doc);
    this.lightMaps = merge(this.dark, doc.light ? normalize(doc.light) : {});
  }

  /** The definition id for a file or folder, or null (the theme has no default for it). */
  resolve(q: IconQuery): string | null {
    const m = q.light ? this.lightMaps : this.dark;
    const name = q.name.toLowerCase();
    if (q.kind === "folder") {
      const byName = q.root
        ? q.expanded
          ? (m.rootFolderNamesExpanded?.[name] ?? m.rootFolderNames?.[name])
          : m.rootFolderNames?.[name]
        : undefined;
      const named =
        byName ??
        (q.expanded
          ? (m.folderNamesExpanded?.[name] ?? m.folderNames?.[name])
          : m.folderNames?.[name]);
      const fallback = q.root
        ? q.expanded
          ? (m.rootFolderExpanded ?? m.rootFolder ?? m.folderExpanded ?? m.folder)
          : (m.rootFolder ?? m.folder)
        : q.expanded
          ? (m.folderExpanded ?? m.folder)
          : m.folder;
      return this.defined(named) ?? this.defined(fallback);
    }
    const byName = this.defined(m.fileNames?.[name]);
    if (byName) return byName;
    // "a.spec.ts": "spec.ts" before "ts" (the longest extension wins, as in VS Code).
    let dot = name.indexOf(".");
    while (dot >= 0) {
      const ext = name.slice(dot + 1);
      const hit = ext ? this.defined(m.fileExtensions?.[ext]) : null;
      if (hit) return hit;
      dot = name.indexOf(".", dot + 1);
    }
    const byLanguage = q.languageId ? this.defined(m.languageIds?.[q.languageId]) : null;
    return byLanguage ?? this.defined(m.file);
  }

  definition(id: string): IconDefinition | undefined {
    return this.doc.iconDefinitions[id];
  }

  private defined(id: string | undefined): string | null {
    return id && this.doc.iconDefinitions[id] ? id : null;
  }
}

function normalize(m: IconMaps): IconMaps {
  return {
    ...m,
    folderNames: lower(m.folderNames),
    folderNamesExpanded: lower(m.folderNamesExpanded),
    rootFolderNames: lower(m.rootFolderNames),
    rootFolderNamesExpanded: lower(m.rootFolderNamesExpanded),
    fileExtensions: lower(m.fileExtensions),
    fileNames: lower(m.fileNames),
  };
}

function merge(base: IconMaps, over: IconMaps): IconMaps {
  const maps = [
    "folderNames",
    "folderNamesExpanded",
    "rootFolderNames",
    "rootFolderNamesExpanded",
    "fileExtensions",
    "fileNames",
    "languageIds",
  ] as const;
  const out: IconMaps = {
    ...base,
    ...Object.fromEntries(Object.entries(over).filter(([, v]) => typeof v === "string")),
  };
  for (const k of maps) out[k] = { ...base[k], ...over[k] };
  return out;
}

/** Checks a parsed JSON file is an icon theme; throws a readable error otherwise. */
export function asIconTheme(json: unknown): IconThemeDocument {
  const d = json as Partial<IconThemeDocument> | null;
  if (!d || typeof d !== "object" || !d.iconDefinitions || typeof d.iconDefinitions !== "object")
    throw new Error("Not a file icon theme (no iconDefinitions).");
  return d as IconThemeDocument;
}
