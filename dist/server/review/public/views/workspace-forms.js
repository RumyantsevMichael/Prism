// Generated from src/server/review/public/views/workspace-forms.ts by scripts/native-build/compile.mjs.
const READ_ONLY = "This tab can only read, so it cannot add or remove workspaces. Run prism review --workspaces to open a tab that can.";
function createWorkspaceForms({ appRoot, writeHeaders, canWrite, confirm, toast, open }) {
  const dialog = document.getElementById("workspace-add-dialog");
  const field = document.getElementById("workspace-add-url");
  const note = document.getElementById("workspace-add-empty");
  const submit = document.getElementById("workspace-add-submit");
  const cancel = document.getElementById("workspace-add-cancel");
  let emptyAddress = null;
  let busy = false;
  const showNote = (text) => {
    note.textContent = text ?? "";
    note.hidden = !text;
  };
  const showError = (message) => {
    field.setAttribute("invalid", "");
    field.setAttribute("error", message);
    field.control?.focus();
  };
  const clearError = () => {
    field.removeAttribute("invalid");
    field.removeAttribute("error");
  };
  const setBusy = (value) => {
    busy = value;
    submit.toggleAttribute("disabled", value);
    field.toggleAttribute("disabled", value);
    submit.textContent = value ? "Adding\u2026" : emptyAddress ? "Add empty store" : "Add workspace";
  };
  async function request(method, route, body) {
    const response = await fetch(`${appRoot}${route}`, { method, headers: { "Content-Type": "application/json", ...writeHeaders() }, body: JSON.stringify(body) }).catch(() => null);
    if (!response) return { status: 0, json: { message: "The review app did not answer. Try again in a moment." } };
    return { status: response.status, json: await response.json().catch(() => ({ message: "The review app returned an unreadable answer." })) };
  }
  async function add() {
    if (busy) return;
    const url = field.value.trim();
    clearError();
    if (!url) {
      showError("Give the store's address.");
      return;
    }
    const confirmEmpty = emptyAddress !== null && emptyAddress === url;
    setBusy(true);
    showNote(confirmEmpty ? "Adding the empty store\u2026" : "Cloning the store. A large store can take a while.");
    const answer = await request("POST", "api/workspaces", { url, ...confirmEmpty ? { confirmEmpty: true } : {} });
    if (answer.status === 200 && answer.json.workspace) {
      emptyAddress = null;
      setBusy(false);
      showNote(null);
      dialog.close();
      open(answer.json.workspace.url, { message: answer.json.merged ? `${answer.json.workspace.name} already holds this store, so the address joined it.` : `Added ${answer.json.workspace.name}.`, tone: "success" });
      return;
    }
    if (answer.json.code === "store_empty") {
      emptyAddress = url;
      setBusy(false);
      showNote("This store's repository holds no commit yet. Choose Add empty store to add it anyway, and its records start there.");
      submit.textContent = "Add empty store";
      return;
    }
    emptyAddress = null;
    setBusy(false);
    showNote(null);
    showError(answer.json.message || "The workspace could not be added.");
  }
  submit.addEventListener("click", () => void add());
  cancel.addEventListener("click", () => dialog.close());
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      void add();
    }
  });
  field.addEventListener("input", () => {
    clearError();
    if (emptyAddress !== null && field.value.trim() !== emptyAddress) {
      emptyAddress = null;
      showNote(null);
      submit.textContent = "Add workspace";
    }
  });
  function openAdd() {
    if (!canWrite()) {
      toast(READ_ONLY, { tone: "warning" });
      return;
    }
    emptyAddress = null;
    field.value = "";
    clearError();
    showNote(null);
    setBusy(false);
    dialog.show();
    requestAnimationFrame(() => field.control?.focus());
  }
  async function remove(entry) {
    if (!canWrite()) {
      toast(READ_ONLY, { tone: "warning" });
      return null;
    }
    const accepted = await confirm({
      title: `Remove ${entry.name}?`,
      message: "The app stops listing this workspace unless a checkout of it is registered. Its store's clone on this machine is deleted only when no checkout here names the store and it holds nothing that is not pushed; the store itself is not changed."
    });
    if (!accepted) return null;
    const answer = await request("DELETE", `api/workspaces/${entry.id}`, {});
    if (answer.status !== 200) {
      toast(answer.json.message || "The workspace could not be removed.", { tone: "danger" });
      return null;
    }
    return answer.json;
  }
  return { openAdd, remove };
}
export {
  createWorkspaceForms
};
