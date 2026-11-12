import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Contract: docs/plans/review-app-ui-kit/slice.md clause 73.
// A control role or a title tooltip set from script code is the same native control as one written as markup.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const { checkKitUsage } = await import(pathToFileURL(path.join(ROOT, "scripts/review-kit/kit-guard.mjs")).href);

async function check(context, files) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-guard-script-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return checkKitUsage({ root, files: Object.keys(files) });
}

test("native-control names control roles and title tooltips set from script code", async (context) => {
  const screen = "src/server/review/public/views/screen.js";
  const findings = await check(context, {
    [screen]: [
      "el.setAttribute(\"role\", \"tab\");",
      "el.setAttribute('title', label);",
      "el.title = \"Full name\";",
      "svgElement(\"g\", { tabindex: 0, role: \"button\" });",
      "this.button.title = label;",
      "el.setAttribute(\"role\", \"region\");",
      "document.title = \"Review\";",
      "const same = el.title === label;",
      "const data = { title: \"Roadmap\", role: \"img\" };",
      "// el.title = \"in a comment\";"
    ].join("\n"),
    "src/server/review/public/kit/elements/prism-tab.js": "this.setAttribute(\"role\", \"tab\");\nthis.title = label;\n"
  });
  const at = (line) => findings.filter((finding) => finding.file === screen && finding.line === line).map((finding) => `${finding.rule} ${finding.value}`);
  assert.deepEqual(at(1), ["native-control setAttribute(\"role\", \"tab\")"]);
  assert.deepEqual(at(2), ["native-control setAttribute('title'"]);
  assert.deepEqual(at(3), ["native-control el.title ="]);
  assert.deepEqual(at(4), ["native-control role: \"button\""]);
  assert.deepEqual(at(5), ["native-control this.button.title ="]);
  for (const line of [6, 7, 8, 9, 10]) assert.deepEqual(at(line), [], `line ${line} passes`);
  assert.equal(findings.filter((finding) => finding.file.includes("/kit/")).length, 0, "the kit sets roles and titles on its own controls");
});
