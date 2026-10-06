import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { copyDependencies } from "./dependencies.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const destination = path.join(root, "dist/native-runtime/node_modules");
await rm(destination, { recursive: true, force: true });
await copyDependencies(path.join(root, "src/native-runtime/node_modules"), destination);
