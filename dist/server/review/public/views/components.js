// Generated from src/server/review/public/views/components.ts by scripts/native-build/compile.mjs.
import { escapeHtml } from "./util.js";
const NAME = "[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?";
const IDENTITY = new RegExp(`^${NAME}/${NAME}$`);
function componentChip(component) {
  if (typeof component !== "string" || !IDENTITY.test(component)) return "";
  return `<prism-chip data-component="${escapeHtml(component)}">${escapeHtml(component)}</prism-chip>`;
}
export {
  componentChip
};
