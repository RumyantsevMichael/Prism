import { CONFORMING } from "./artifact-formats.mjs";
import { checkout, commitFiles, git, isolateGit, server, workspace } from "./workspace-artifacts.mjs";

// Projects whose .prism/workflow.md names a record store, so their requirements, ADRs, and glossary are store artifacts while feature files stay in the checkout.
export { commitFiles, git, isolateGit };

/** The configured paths of the format fixtures' project, as `## Paths` lines. */
export const STORE_PATHS = Object.freeze(["- Requirements: docs/requirements/", "- ADRs: docs/ADRs/", "- Plans: docs/plans/", "- Feature files: docs/Features/", "- Roadmap: docs/roadmap.md", "- Glossary: docs/Glossary.md"]);

/** The component that the checkout `api` declares, whose scope is labeled `api/billing`. */
export const COMPONENTS = Object.freeze(["- billing: packages/billing", `  - Test command: ${process.execPath} -e "process.exit(0)"`]);

/** One tool call's response as { result, error, text, value }, where value is the structured result or the refusal's data, as the format tests read it. */
const wrapped = (prism) => async (name, args = {}) => {
  const message = await prism.call(name, args);
  const text = (message.result?.content ?? []).map((item) => item.text ?? "").join("\n") || message.error?.message || "";
  return { result: message.result ?? null, error: message.error ?? null, text, value: message.result?.structuredContent ?? (message.error ? { code: message.error.data?.code, message: message.error.message, ...message.error.data } : null) };
};

// Git's private home and identity are set once for the test file, before any checkout is made.
let isolated = null;

/**
 * A store workspace with the checkout `api`, which declares the component `billing` and commits files, the conforming set by default:
 * the first tool call moves its requirements, ADRs, and glossary into the repository scope `api` with their written statuses, and its feature files stay in the checkout.
 * Returns { place, root, call }, with call as the format tests use it.
 */
export async function storeProject(context, files = CONFORMING, { store } = {}) {
  isolated ??= isolateGit();
  await isolated;
  const place = await workspace(context);
  const root = await checkout(place, "api", { paths: [...STORE_PATHS], components: [...COMPONENTS], files, ...(store === undefined ? {} : { store }) });
  const prism = await server(context, place, root);
  return { place, root, call: wrapped(prism) };
}

/** A second repository's checkout `web` in the same store, which sees only the workspace scope and its own: { root, call }. */
export async function otherCheckout(context, place, files = {}) {
  const root = await checkout(place, "web", { paths: [...STORE_PATHS], files });
  return { root, call: wrapped(await server(context, place, root)) };
}

/** Write one store artifact through update_artifact, in the given scope when one is named, and return its result entry. */
export async function storeWrite(call, file, content, { scope, component, expectedVersion = null } = {}) {
  const result = await call("update_artifact", { operations: [{ op: "write", path: file, content, expectedVersion, ...(scope ? { scope } : {}), ...(component ? { component } : {}) }] });
  if (result.error || result.result?.isError) throw new Error(`update_artifact failed: ${result.text}`);
  return result.value.artifacts[0];
}

/** Read one store artifact through get_artifact, in the given scope when one is named. */
export async function storeRead(call, file, { scope, component } = {}) {
  const result = await call("get_artifact", { path: file, ...(scope ? { scope } : {}), ...(component ? { component } : {}) });
  if (result.error || result.result?.isError) throw new Error(`get_artifact failed: ${result.text}`);
  return result.value;
}

/** The scope label of a result entry's scope, or null for a checkout file. */
export const labelOf = (entry) => entry?.scope === null ? null : entry?.scope?.label;
