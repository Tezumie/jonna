// Monaco's editor worker (diff computation, word-based suggestions, link detection).
// Built as a separate classic script (build.mjs) and created by MonacoEnvironment.getWorker.
import { start } from "monaco-editor/editor/editor.worker.start.js";

// Monaco's main thread sends an init message first; start the worker server on it.
let started = false;
self.onmessage = () => {
  if (!started) {
    started = true;
    start(() => ({}));
  }
};
