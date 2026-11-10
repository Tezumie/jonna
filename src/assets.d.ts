// esbuild loaders (build.mjs): SVG files import as text, CSS imports are bundled to main.css.
declare module "*.svg" {
  const content: string;
  export default content;
}
declare module "*.css";
declare module "*?raw" {
  const content: string;
  export default content;
}

/** The Node extension host's script (D255; build.mjs's nodeHostPlugin). */
declare module "virtual:node-host" {
  const text: string;
  export default text;
}
