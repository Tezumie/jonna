// Authors on an extension's page (D185): their pictures overlapping in the header, like a
// repository's contributors, and a list in the side panel. A picture is a GitHub user's (fetched
// and cached by the backend), one of the IDE's brand marks, or initials on a label color.

import { h, on } from "../../core/dom/index";
import { authorsText, type ExtensionAuthor } from "../../core/extensions/authors";
import { extIpc } from "../../core/ipc/extensions";
import type { WorkbenchServices } from "../../workbench/services";
import { BRAND_LOGOS } from "../agent/brandLogos";

/** GitHub pictures as data: URLs (null: none), once per login while the IDE runs. */
const pictures = new Map<string, Promise<string | null>>();

function sniff(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return null;
}

function githubPicture(login: string): Promise<string | null> {
  const key = login.toLowerCase();
  let picture = pictures.get(key);
  if (!picture) {
    picture = extIpc.githubAvatar(login).then(
      (bytes) => {
        const type = sniff(bytes);
        if (!type) return null;
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000)
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return `data:${type};base64,${btoa(binary)}`;
      },
      () => null,
    );
    pictures.set(key, picture);
  }
  return picture;
}

const initials = (name: string) =>
  (name.match(/\b[\p{L}\p{N}]/gu) ?? [name[0] ?? "?"]).slice(0, 2).join("").toUpperCase();

/** A stable label color (1–6) for a name. */
const labelOf = (name: string) => {
  let n = 0;
  for (const ch of name) n = (n * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return (n % 6) + 1;
};

export function authorAvatar(a: ExtensionAuthor, large = false): HTMLElement {
  const brand = a.avatar?.startsWith("brand:") ? a.avatar.slice(6) : null;
  const logo = brand && Object.hasOwn(BRAND_LOGOS, brand) ? BRAND_LOGOS[brand] : undefined;
  if (brand && logo) {
    const el = h("span", {
      class: {
        "ext-author-avatar": true,
        "is-brand": true,
        "is-mono": logo.mono,
        "is-large": large,
      },
      "data-brand": brand,
      "aria-hidden": "true",
    });
    if (logo.mono) {
      const mask = h("span", { class: "ext-author-mask" });
      mask.style.setProperty("--logo", `url("${logo.src}")`);
      el.append(mask);
    } else el.append(h("img", { src: logo.src, alt: "", draggable: "false" }));
    return el;
  }
  const el = h(
    "span",
    {
      class: `ext-author-avatar is-label-${labelOf(a.name)}${large ? " is-large" : ""}`,
      "aria-hidden": "true",
    },
    initials(a.name),
  );
  if (a.github)
    void githubPicture(a.github).then((src) => {
      if (!src) return;
      el.className = `ext-author-avatar has-picture${large ? " is-large" : ""}`;
      el.replaceChildren(h("img", { src, alt: "", draggable: "false" }));
    });
  return el;
}

/** The header's line: up to five pictures overlapping, then the names. */
export function authorsLine(authors: readonly ExtensionAuthor[]): HTMLElement {
  return h(
    "span",
    { class: "ext-authors" },
    h("span", { class: "ext-author-stack" }, ...authors.slice(0, 5).map((a) => authorAvatar(a))),
    h("span", { class: "ext-authors-names" }, authorsText(authors)),
  );
}

/** The side panel's list: a picture and a name each, a link to their profile when known. */
export function authorsList(
  services: WorkbenchServices,
  authors: readonly ExtensionAuthor[],
): HTMLElement {
  return h(
    "div",
    { class: "ext-author-list" },
    ...authors.map((a) => {
      const href = a.github ? `https://github.com/${a.github}` : a.url;
      const row = h(
        href ? "a" : "span",
        { class: "ext-author-row", ...(href && { href, role: "link" }) },
        authorAvatar(a, true),
        h(
          "span",
          { class: "ext-author-text" },
          h("span", { class: "ext-author-name" }, a.name),
          a.github ? h("span", { class: "ext-author-login" }, `@${a.github}`) : null,
        ),
      );
      if (href)
        on(row, "click", (e) => {
          e.preventDefault();
          void services.dispatcher.execute("ui.openLink", { url: href }).catch(() => {});
        });
      return row;
    }),
  );
}
