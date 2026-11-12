import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Prism reads a project's plan files from its record store when its configuration names one, and from the checkout otherwise,
// so fixtures write them where Prism reads them. Prism modules load only inside the helper, after a test has set PLUGIN_DATA.

/** Whether a project's .prism/workflow.md names a record store under ## Workspace. */
export async function namesStore(root) {
  const config = await readFile(path.join(root, ".prism", "workflow.md"), "utf8").catch(() => "");
  return /^-\s*Store\s*:/im.test(config);
}

/** Write a plan file, or append to it, through update_artifact in a project with a store, else in the checkout. */
export async function writePlanFile(root, file, contents, { append = false } = {}) {
  if (!(await namesStore(root))) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await (append ? appendFile : writeFile)(path.join(root, file), contents);
    return;
  }
  const { getArtifact, updateArtifact } = await import("../../../dist/server/workflow/store-artifacts.mjs");
  const current = await getArtifact({ projectRoot: root, path: file }).catch((error) => { if (error.code === "artifact_not_found") return null; throw error; });
  const content = append && current ? `${current.content}${contents}` : contents;
  await updateArtifact({ projectRoot: root, operations: [{ op: "write", path: file, content, expectedVersion: current?.version ?? null }] });
}
