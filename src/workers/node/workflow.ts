// Node only: the workflow worker (workers/workflow.worker.ts) for a Node worker thread, built by
// `node build.mjs --headless` as `workflow.worker.mjs` beside the brain. The scope comes first:
// the worker script reads `self` as it loads.
import "./scope";
import "../workflow.worker";
