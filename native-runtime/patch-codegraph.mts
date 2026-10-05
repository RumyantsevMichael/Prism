import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const PATCH_VERSION = "prism-embedded-1";
export const PATCHES = [
  { file: "extraction/tree-sitter.js", before: `            if (!this.tree) {
                throw new Error('Parser returned null tree');
            }`, after: `            if (!this.tree) {
                throw new Error('Parser returned null tree');
            }
            if (process.env.PRISM_EMBEDDED === '1' && this.tree.rootNode.hasError) {
                this.errors.push({ message: 'Source contains parser error or missing syntax nodes',
                    filePath: this.filePath, severity: 'error', code: 'syntax_error' });
            }` },
  { file: "extraction/index.js", before: "const useWorker = fs.existsSync(parseWorkerPath);", after: "const useWorker = process.env.PRISM_EMBEDDED !== '1' && fs.existsSync(parseWorkerPath);" },
  { file: "db/index.js", before: "    async checkpointWal(mode) {", after: `    async checkpointWal(mode) {
        if (process.env.PRISM_EMBEDDED === '1') {
            if (mode !== 'PASSIVE' && mode !== 'TRUNCATE') throw new Error('Invalid embedded checkpoint mode.');
            const row = this.db.prepare('PRAGMA wal_checkpoint(' + mode + ')').get();
            return row ? { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) } : null;
        }` },
  { file: "db/index.js", before: "    async runPragmasOffThread(pragmas, inlineFallback = []) {", after: `    async runPragmasOffThread(pragmas, inlineFallback = []) {
        if (process.env.PRISM_EMBEDDED === '1') {
            for (const pragma of pragmas) this.db.exec(pragma);
            return;
        }` }
];

export async function patchCodeGraph(directory: string) {
  const records = [];
  for (const name of [...new Set(PATCHES.map(item => item.file))]) {
    const file = path.join(directory, name);
    const original = await readFile(file, "utf8");
    let source = original;
    for (const patch of PATCHES.filter(item => item.file === name)) {
      if (source.includes(patch.after)) continue;
      if (source.split(patch.before).length !== 2) throw new Error(`The pinned CodeGraph patch anchor changed: ${name}.`);
      source = source.replace(patch.before, patch.after);
    }
    await writeFile(file, source);
    const upstream = PATCHES.filter(item => item.file === name).reduce((text, patch) => text.replace(patch.after, patch.before), source);
    records.push({ file: name, before: digest(upstream), after: digest(source) });
  }
  return { schemaVersion: 1, upstream: "@colbymchenry/codegraph@1.6.0", patchVersion: PATCH_VERSION, files: records };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await patchCodeGraph(process.argv[2]), null, 2));
}
