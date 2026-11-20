// Generated from src/server/review/public/views/missing-tab.ts by scripts/native-build/compile.mjs.
function missingNotice(ref, { entity = false, label = ref } = {}) {
  if (entity) {
    return {
      title: "This item no longer exists",
      tooltip: `${label} no longer exists in this project.`,
      detail: "The records that described it were removed or renamed. The page returns to normal if they come back."
    };
  }
  return {
    title: "This file no longer exists",
    tooltip: `${ref} no longer exists. It was moved or deleted.`,
    detail: "It was moved or deleted. The page returns to normal if the file comes back, for example after a checkout."
  };
}
function nextMissingTabs(current, reported) {
  const next = new Set(Array.isArray(reported) ? reported.filter((tab) => typeof tab === "string") : []);
  const changed = next.size !== current.size || [...next].some((tab) => !current.has(tab));
  return { next, changed };
}
function renderMissing(container, ref, { entity = false, label = ref, onClose } = {}) {
  const notice = missingNotice(ref, { entity, label });
  const state = document.createElement("prism-empty-state");
  state.className = "missing-page";
  state.setAttribute("heading", notice.title);
  const where = document.createElement("p");
  where.className = "missing-path";
  where.textContent = entity && label !== ref ? label : ref;
  if (!entity) where.dataset.codeSubject = "";
  const detail = document.createElement("p");
  detail.className = "missing-detail";
  detail.textContent = notice.detail;
  const close = document.createElement("prism-button");
  close.setAttribute("variant", "primary");
  close.textContent = "Close tab";
  close.addEventListener("click", () => onClose?.());
  state.append(where, detail, close);
  container.replaceChildren(state);
}
export {
  missingNotice,
  nextMissingTabs,
  renderMissing
};
