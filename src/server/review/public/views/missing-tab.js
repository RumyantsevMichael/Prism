// A tab keeps the path or entity it named, so when that file is moved or deleted, or that entity stops resolving,
// the tab is dimmed and its page says so instead of showing the server's error.

/** The words for a tab whose target is gone: a file by its path, an entity by its label. */
export function missingNotice(ref, { entity = false, label = ref } = {}) {
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

/** The set of missing tabs a snapshot reports, and whether it differs from the set the tab strip shows. */
export function nextMissingTabs(current, reported) {
  const next = new Set(Array.isArray(reported) ? reported.filter((tab) => typeof tab === "string") : []);
  const changed = next.size !== current.size || [...next].some((tab) => !current.has(tab));
  return { next, changed };
}

/** Render the page of a missing page into container; onClose leaves it for the page before it. */
export function renderMissing(container, ref, { entity = false, label = ref, onClose } = {}) {
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
  close.textContent = "Close this page";
  close.addEventListener("click", () => onClose?.());
  state.append(where, detail, close);
  container.replaceChildren(state);
}
