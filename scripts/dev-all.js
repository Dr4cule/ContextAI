#!/usr/bin/env node
/**
 * ContextAI dev-all launcher.
 *
 * Spawns every backend service in its own child process and pipes their
 * output to a single labelled stream. Use this when you want all of the
 * services up at once without opening four terminals.
 *
 *   npm run dev:all
 *
 * Each child is reaped on Ctrl+C (SIGINT) so no orphan processes are left
 * behind.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const services = [
  { name: "rag", cwd: path.join(root, "server"), cmd: "node", args: ["index.js"] },
  { name: "whatsapp", cwd: path.join(root, "backend"), cmd: "node", args: ["whatsapp_api.js"] },
  { name: "discord", cwd: path.join(root, "backend"), cmd: "node", args: ["discord_api.js"] },
  { name: "ui", cwd: path.join(root, "backend", "whatsapp_ui"), cmd: "npx", args: ["vite"] },
];

const children = services.map((s) => {
  const child = spawn(s.cmd, s.args, { cwd: s.cwd, shell: true, env: process.env });
  const prefix = `[${s.name}]`;
  const pipe = (stream, tag) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) console.log(prefix, tag, line);
    });
    stream.on("end", () => {
      if (buf) console.log(prefix, tag, buf);
    });
  };
  pipe(child.stdout, "out");
  pipe(child.stderr, "err");
  child.on("exit", (code) => console.log(prefix, "exited with code", code));
  return child;
});

const shutdown = (signal) => {
  console.log(`\nReceived ${signal}, shutting down...`);
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch (_) {}
  }
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
