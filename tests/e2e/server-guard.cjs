// Preloaded only in the fixture server, before Next/provider imports.
const { syncBuiltinESMExports } = require("node:module");
function deny(boundary) {
  return function () { throw new Error(`Unexpected browser-test server IO: ${boundary}`); };
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  require("node:child_process")[name] = deny(`process.${name}`);
}
for (const transport of ["node:http", "node:https"]) {
  for (const name of ["get", "request"]) require(transport)[name] = deny(`${transport}.${name}`);
}
const net = require("node:net");
net.connect = deny("net.connect");
net.createConnection = deny("net.createConnection");
net.Socket.prototype.connect = deny("Socket.connect");
require("node:tls").connect = deny("tls.connect");
globalThis.fetch = deny("fetch");
globalThis.WebSocket = deny("WebSocket");
syncBuiltinESMExports();
