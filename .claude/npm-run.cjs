// Runs `npm run <script> [args...]` with node's own directory on PATH.
// The shell that launches previews has no node/npm on PATH, so npm-spawned
// .bin shims (vite, etc.) die with '"node" is not recognized'. Launching
// this via the absolute node.exe fixes that without touching any npm script.
const path = require("path");
const { spawn } = require("child_process");
const nodeDir = path.dirname(process.execPath);
process.env.PATH = nodeDir + path.delimiter + (process.env.PATH || "");
const npmCli = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
const child = spawn(process.execPath, [npmCli, "run", ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code == null ? 1 : code));
