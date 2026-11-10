// monaco-editor ships no typings for its worker bootstrap module.
declare module "monaco-editor/editor/editor.worker.start.js" {
  export function start(createClient: (context: unknown) => object): unknown;
}
