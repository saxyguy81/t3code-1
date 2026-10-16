const { createRequire } = require("node:module");
const req = createRequire(process.argv[2] + "/package.json");
const out = { node: process.version, abi: process.versions.modules, napi: process.versions.napi };
for (const m of ["node-pty", "@napi-rs/keyring", "@ff-labs/fff-node"]) {
  try {
    const mod = req(m);
    out[m] = "ok:" + Object.keys(mod).slice(0, 4).join(",");
  } catch (e) { out[m] = "FAIL:" + e.message.split("\n")[0]; }
}
try {
  const pty = req("node-pty");
  const p = pty.spawn("/bin/echo", ["pty-ok"], {});
  let buf = ""; p.onData((d) => (buf += d));
  p.onExit(() => { out["node-pty spawn"] = buf.trim(); console.log(JSON.stringify(out)); });
} catch (e) { out["node-pty spawn"] = "FAIL:" + e.message; console.log(JSON.stringify(out)); }
