// Show what spawning a shell test command in a folder that does not exist reports, as verify_slice would for a declared component folder not created yet.
// Usage: node docs/plans/components/component-slices/probes/missing-folder.mjs
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const child = spawn("echo ok", { cwd: path.join(os.tmpdir(), "prism-no-such-folder"), shell: true });
child.on("error", (error) => console.log(JSON.stringify({ event: "error", code: error.code, message: error.message })));
child.on("close", (code) => console.log(JSON.stringify({ event: "close", code })));
