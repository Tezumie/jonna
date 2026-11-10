// A minimal server for tests: prints its address like a dev server does, then serves one page.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3000);
createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>Served</title><h1>Served page</h1>");
}).listen(port, "127.0.0.1", () => console.log(`Server running at http://localhost:${port}/`));
