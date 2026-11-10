// Colors for language servers' semantic tokens (D204). Monaco's standalone theme looks a token
// type up as a theme rule of the same name ("function"), which TextMate themes such as Dark+ don't
// have, so every semantic token would turn the default color. VS Code maps each standard type
// (and some type + modifier pairs) to TextMate scopes and uses the theme's color for the first
// scope it has; we do the same here, and leave a token's syntax color alone when no scope matches.
// Extensions add their own selectors (VS Code's `semanticTokenScopes`, per language or for all)
// and custom types falling back to standard ones (`semanticTokenTypes`' superType); the scope
// rules themselves are DOM-free (../semanticScopes.ts).
import { TokenMetadata } from "monaco-editor/editor/common/encodedTokenAttributes.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IStandaloneThemeService } from "monaco-editor/editor/standalone/common/standaloneTheme.js";
import type { ContributedSemanticTokenScopes } from "../engine";
import { semanticScopes } from "../semanticScopes";

/** The extensions' semantic token scopes in use (setSemanticScopes). */
let contributed: readonly ContributedSemanticTokenScopes[] = [];

/** Replaces the extensions' semantic token scopes (themes color by them from the next lookup). */
export function setSemanticScopes(list: readonly ContributedSemanticTokenScopes[]): void {
  contributed = list;
}

interface TokenThemeLike {
  _match(token: string): { metadata: number };
}

interface StandaloneThemeLike {
  tokenTheme: TokenThemeLike;
  getTokenStyleMetadata(type: string, modifiers: string[], language: string): unknown;
}

let installed = false;

/** Replaces the standalone theme's semantic token lookup with the scope mapping (once). */
export function installSemanticStyling(): void {
  if (installed) return;
  installed = true;
  const service = StandaloneServices.get(IStandaloneThemeService) as {
    getColorTheme(): StandaloneThemeLike;
  };
  const proto = Object.getPrototypeOf(service.getColorTheme()) as StandaloneThemeLike;
  proto.getTokenStyleMetadata = function (this: StandaloneThemeLike, type, modifiers, language) {
    const theme = this.tokenTheme;
    const none = theme._match("");
    for (const scope of semanticScopes(type, modifiers, language, contributed)) {
      const rule = theme._match(scope);
      if (rule === none) continue;
      const fontStyle = TokenMetadata.getFontStyle(rule.metadata) as number;
      return {
        foreground: TokenMetadata.getForeground(rule.metadata) as number,
        italic: Boolean(fontStyle & 1),
        bold: Boolean(fontStyle & 2),
        underline: Boolean(fontStyle & 4),
        strikethrough: Boolean(fontStyle & 8),
      };
    }
    // No scope the theme colors: keep the syntax color.
    return undefined;
  };
}
