// Loopback pass-through to the t2 router that records one JSON line per request:
// time, method, path, model, status and the response's id headers. No bodies, no auth headers.
// usage: node router-tap.mjs <listenPort> <logFile>   (upstream fixed to the t2 router)
import { appendFileSync } from "node:fs";
import http from "node:http";

const [port, logFile] = process.argv.slice(2);
const upstream = { host: "127.0.0.1", port: 18788 };
const idHeader = /(^|-)(request|req|turn|conversation|conv|attempt|trace)(-|_)?id$|^x-ccproxy-/i;

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let model = null;
      try {
        model = JSON.parse(body.toString("utf8")).model ?? null;
      } catch {}
      const started = new Date().toISOString();
      const out = http.request(
        { ...upstream, method: req.method, path: req.url, headers: req.headers },
        (up) => {
          const ids = Object.fromEntries(
            Object.entries(up.headers).filter(([name]) => idHeader.test(name)),
          );
          appendFileSync(
            logFile,
            JSON.stringify({ started, method: req.method, path: req.url, model, status: up.statusCode, ids }) +
              "\n",
          );
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      out.on("error", (error) => {
        appendFileSync(logFile, JSON.stringify({ started, method: req.method, path: req.url, model, error: error.message }) + "\n");
        res.writeHead(502).end();
      });
      out.end(body);
    });
  })
  .listen(Number(port), "127.0.0.1");
