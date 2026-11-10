// The Graph's rows as small SVGs (D139, D210): lanes through, joins from above, edges to the
// parents and the dot — a ring for HEAD, a dashed circle for the incoming / outgoing changes rows
// (VS Code's). Lines and dots take their lane's color class (scm-lane-ref, -remote, -0…-4).

import type { GraphRow, LaneColor } from "./graph";

/** Graph geometry (px): lane width and the row height the Tree uses. */
export const LANE_W = 10;
export const ROW_H = 22;

/** A graph lane that continues past a row (drawn through an expanded commit's files). */
export type Lane = { lane: number; color: LaneColor };

const SVG_NS = "http://www.w3.org/2000/svg";
const laneX = (lane: number) => LANE_W / 2 + lane * LANE_W;

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** One row of the graph; `node` is how its dot looks. */
export function graphSvg(row: GraphRow, node: "commit" | "head" | "sync"): SVGSVGElement {
  const width = row.width * LANE_W;
  const svg = svgEl("svg", {
    class: "scm-graph",
    width,
    height: ROW_H,
    viewBox: `0 0 ${width} ${ROW_H}`,
    "aria-hidden": "true",
  });
  const mid = ROW_H / 2;
  for (const e of row.edges) {
    const a = laneX(e.from);
    const b = laneX(e.to);
    const d =
      e.part === "through"
        ? `M${a} 0V${ROW_H}`
        : e.part === "top"
          ? a === b
            ? `M${a} 0V${mid}`
            : `M${a} 0C${a} ${mid * 0.7} ${b} ${mid * 0.3} ${b} ${mid}`
          : a === b
            ? `M${a} ${mid}V${ROW_H}`
            : `M${a} ${mid}C${a} ${mid * 1.7} ${b} ${mid * 1.3} ${b} ${ROW_H}`;
    svg.append(svgEl("path", { d, class: `scm-lane scm-lane-${e.color}` }));
  }
  const x = laneX(row.lane);
  const kind = node === "sync" ? " is-sync" : node === "head" ? " is-head" : "";
  svg.append(
    svgEl("circle", {
      cx: x,
      cy: mid,
      r: node === "commit" ? 3 : 4,
      class: `scm-dot scm-lane-${row.color}${row.merge ? " is-merge" : ""}${kind}`,
    }),
  );
  return svg;
}

/** The lanes that run on below a row (its parents' and the ones passing through). */
export function continuingLanes(row: GraphRow): Lane[] {
  const seen = new Map<number, LaneColor>();
  for (const e of row.edges)
    if ((e.part === "bottom" || e.part === "through") && !seen.has(e.to)) seen.set(e.to, e.color);
  return [...seen].map(([lane, color]) => ({ lane, color }));
}

/** The graph's lines running past an expanded row's files. */
export function lanesSvg(lanes: readonly Lane[]): SVGSVGElement {
  const width = Math.max(0, ...lanes.map((l) => l.lane + 1)) * LANE_W;
  const svg = svgEl("svg", {
    class: "scm-graph scm-graph-files",
    width,
    height: ROW_H,
    viewBox: `0 0 ${width} ${ROW_H}`,
    "aria-hidden": "true",
  });
  for (const l of lanes)
    svg.append(
      svgEl("path", {
        d: `M${laneX(l.lane)} 0V${ROW_H}`,
        class: `scm-lane scm-lane-${l.color}`,
      }),
    );
  return svg;
}
