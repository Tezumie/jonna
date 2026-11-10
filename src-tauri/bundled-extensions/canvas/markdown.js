// A small, safe Markdown renderer for canvas cards (the page can't use the IDE's): headings,
// paragraphs, lists and task lists, quotes, code blocks, tables, rules, and inline code, bold,
// italics, strikethrough and links. Nothing in the text becomes HTML (see inline()).
// Task list items carry data-line (the source line) so a click can tick them.

(() => {
  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const link = (url, inner) =>
    `<a class="md-link" data-url="${escapeHtml(url)}" title="${escapeHtml(url)} (Ctrl+click)">${inner}</a>`;

  /**
   * Inline Markdown. Everything that makes an element with attributes (links) or holds raw text
   * (code) is built from the unescaped text into a placeholder first, its parts escaped on their
   * own; then the rest is escaped and only gets bare tags (bold, italics). No rule ever runs over
   * HTML another rule built, so nothing in the text can reach an attribute or a tag.
   */
  function inline(text) {
    const held = [];
    const hold = (html) => {
      held.push(html);
      return `\uE000${held.length - 1}\uE001`;
    };
    // URLs stop at quotes and angle brackets (and the placeholder characters can't be typed in).
    const URL = "https?:\\/\\/[^\\s()<>\"'\\uE000\\uE001]+";
    let s = String(text).replace(/[\uE000\uE001]/g, "");
    s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code class="md-code">${escapeHtml(c)}</code>`));
    s = s.replace(new RegExp(`\\[([^\\]]+)\\]\\((${URL})\\)`, "g"), (_, label, url) =>
      hold(link(url, escapeHtml(label))),
    );
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) =>
      hold(`<span class="md-wiki">${escapeHtml(label ?? target)}</span>`),
    );
    s = s.replace(
      new RegExp(`(^|[\\s(])(${URL})`, "g"),
      (_, pre, url) => `${pre}${hold(link(url, escapeHtml(url)))}`,
    );
    s = escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s.replace(/\uE000(\d+)\uE001/g, (_, i) => held[Number(i)] ?? "");
  }

  function table(lines) {
    const cells = (l) =>
      l
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => inline(c.trim()));
    const head = cells(lines[0]);
    const rows = lines.slice(2).map(cells);
    return `<div class="md-table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`;
  }

  /** `offset`: the first line's number in the card's text (a quote's lines are rendered on their own). */
  function render(source, offset = 0) {
    const lines = String(source ?? "").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*```\s*([\w+-]*)/.exec(line);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
        i++;
        // The IDE's code block markup (D187): styled like the Markdown preview's.
        out.push(
          `<div class="md-pre"><pre><code>${escapeHtml(body.join("\n"))}</code></pre></div>`,
        );
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        out.push(table(rows));
        continue;
      }
      if (/^\s*>/.test(line)) {
        const body = [];
        const first = i;
        while (i < lines.length && /^\s*>/.test(lines[i]))
          body.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${render(body.join("\n"), offset + first)}</blockquote>`);
        continue;
      }
      const item = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
      if (item) {
        const ordered = /\d/.test(item[2]);
        const items = [];
        while (i < lines.length) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!m) break;
          const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
          const indent = Math.min(4, Math.floor(m[1].length / 2));
          items.push(
            task
              ? `<li class="task md-task" data-indent="${indent}"><input type="checkbox" data-line="${offset + i}"${task[1] === " " ? "" : " checked"}> ${inline(task[2])}</li>`
              : `<li data-indent="${indent}">${inline(m[3])}</li>`,
          );
          i++;
        }
        out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s+|\s*\|.*\|\s*$)/.test(lines[i])
      )
        para.push(inline(lines[i++]));
      if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
      else i++;
    }
    return out.join("");
  }

  /** Ticks or unticks the task on `line` of the source. */
  function toggleTask(source, line) {
    const lines = String(source).split("\n");
    const l = lines[line];
    if (l === undefined) return source;
    lines[line] = l.replace(
      /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/,
      (_, pre, mark) => `${pre}[${mark === " " ? "x" : " "}]`,
    );
    return lines.join("\n");
  }

  self.canvasMarkdown = { render, toggleTask };
})();
