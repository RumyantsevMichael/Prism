import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { generateRuntime } from "./runtime-output.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
execFileSync(process.execPath, [fileURLToPath(new URL("./node_modules/typescript/bin/tsc", import.meta.url)), "--project", path.join(root, "tsconfig.native.json")], { stdio: "inherit" });
await generateRuntime(root, { check: process.argv.includes("--check") });
