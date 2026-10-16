// Proof client for hanan-work#303 scratch hubs. Never point it at a live hub.
// usage:
//   node t3.mjs get  <path>
//   node t3.mjs post <path> '<json>'
//   node t3.mjs ws   '<v2 command json>'
//   node t3.mjs sql  '<select>'           (read-only, scratch DB)
// env: T3P_URL (http://127.0.0.1:PORT), T3P_TOKEN, T3P_DB
import { DatabaseSync } from "node:sqlite";

const [cmd, a, b] = process.argv.slice(2);
const url = process.env.T3P_URL;
const token = process.env.T3P_TOKEN;
if (!url?.startsWith("http://127.0.0.1:")) throw new Error("T3P_URL must be a loopback scratch hub");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const http = async (method, path, body) => {
  const res = await fetch(url + path, { method, headers, body });
  const text = await res.text();
  console.log(JSON.stringify({ status: res.status, body: tryJson(text) }));
  process.exitCode = res.ok ? 0 : 1;
};
const tryJson = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

if (cmd === "get") await http("GET", a);
else if (cmd === "post") await http("POST", a, b);
else if (cmd === "sql") {
  const db = new DatabaseSync(process.env.T3P_DB, { readOnly: true });
  console.log(JSON.stringify(db.prepare(a).all()));
} else if (cmd === "ws") {
  const ws = new WebSocket(
    `${url.replace("http", "ws")}/ws?orchestrationProtocol=2`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws timeout")), 15_000);
    ws.onmessage = (event) => {
      for (const line of String(event.data).split("\n").filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
        if (msg._tag === "Exit" || msg._tag === "Defect" || msg._tag === "ClientProtocolError") {
          clearTimeout(timer);
          resolve(msg);
        }
      }
    };
    ws.onerror = (e) => reject(new Error(`ws error ${e.message ?? ""}`));
  });
  ws.onopen = () =>
    ws.send(
      JSON.stringify({
        _tag: "Request",
        id: "1",
        tag: "orchestration.dispatchCommand",
        payload: JSON.parse(a),
        headers: [],
      }),
    );
  const msg = await done;
  console.log(JSON.stringify(msg));
  ws.close();
  process.exitCode = msg._tag === "Exit" && msg.exit?._tag === "Success" ? 0 : 1;
} else throw new Error(`unknown command ${cmd}`);
