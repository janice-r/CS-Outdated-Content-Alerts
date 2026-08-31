#!/usr/bin/env node
// Local dev harness — NOT part of the Launch deployment.
// Serves the static app and adapts the Launch function signature
// (handler(request, response) with response.status().send()) to Node HTTP,
// so the app can be tested locally exactly as it will run on Launch.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || 4310;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function makeResponse(res) {
  return {
    status(code) {
      res.statusCode = code;
      return this;
    },
    send(payload) {
      if (typeof payload === "object") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
      } else {
        res.end(String(payload));
      }
    },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Function routes.
  if (url.pathname === "/report" || url.pathname === "/send-email") {
    const mod = await import(`../functions/${url.pathname === "/report" ? "report" : "send-email"}.js?t=${Date.now()}`);
    const body = req.method === "POST" ? await readBody(req) : undefined;
    return mod.default({ url: req.url, method: req.method, body }, makeResponse(res));
  }

  // Static files.
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const abs = path.join(ROOT, filePath);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  res.setHeader("Content-Type", MIME[path.extname(abs)] || "application/octet-stream");
  fs.createReadStream(abs).pipe(res);
});

server.listen(PORT, () => console.log(`Dev server on http://localhost:${PORT}`));
