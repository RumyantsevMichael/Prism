// A tab keeps the path or entity it named, so when that file is moved or deleted, or that entity stops resolving,
// the tab is dimmed and its page says so instead of showing the server's error.

/** The words for a tab whose target is gone: a file by its path, an entity by its label. */
export function missingNotice(ref, { entity = false, label = ref } = {}) {
  if (entity) {
    return {
      title: "This item no longer exists",
      tooltip: `${label} no longer exists in this project.`,
      detail: "The records that described it were removed or renamed. The tab returns to normal if they come back."
    };
  }
  return {
    title: "This file no longer exists",
    tooltip: `${ref} no longer exists. It was moved or deleted.`,
    detail: "It was moved or deleted. The tab returns to normal if the file comes back, for example after a checkout."
  };
}

/** The set of missing tabs a snapshot reports, and whether it differs from the set the tab strip shows. */
export function nextMissingTabs(current, reported) {
  const next = new Set(Array.isArray(reported) ? reported.filter((tab) => typeof tab === "string") : []);
  const changed = next.size !== current.size || [...next].some((tab) => !current.has(tab));
  return { next, changed };
}

/** Render the page of a missing tab into container; onClose closes the tab. */
export function renderMissing(container, ref, { entity = false, label = ref, onClose } = {}) {
  const notice = missingNotice(ref, { entity, label });
  const card = document.createElement("section");
  card.className = "missing-card";
  card.setAttribute("aria-labelledby", "missing-title");
  const mark = document.createElement("span");
  mark.className = "missing-mark";
  mark.setAttribute("aria-hidden", "true");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = entity ? "Missing item" : "Missing file";
  const title = document.createElement("h1");
  title.id = "missing-title";
  title.textContent = notice.title;
  const where = document.createElement("p");
  where.className = "missing-path";
  where.textContent = entity && label !== ref ? `${label} (${ref})` : ref;
  const detail = document.createElement("p");
  detail.className = "missing-detail";
  detail.textContent = notice.detail;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "tool-button primary missing-close";
  close.textContent = "Close tab";
  close.setAttribute("aria-label", `Close the tab for ${label}`);
  close.addEventListener("click", () => onClose?.());
  card.append(mark, eyebrow, title, where, detail, close);
  container.replaceChildren(card);
}
