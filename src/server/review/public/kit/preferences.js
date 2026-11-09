// Keeps the page's theme and density in step with the user's choice.
// The review app stores the choice for the user (GET and PUT api/preferences), because browser storage is separate for every port;
// this browser's copy of the last choice lets boot.js apply it before the first paint.

export const THEMES = Object.freeze(["system", "light", "dark"]);
export const DENSITIES = Object.freeze(["compact", "comfortable"]);
export const DEFAULT_PREFERENCES = Object.freeze({ theme: "system", density: "compact" });

const STORAGE_KEY = "prism-preferences";
// The route sits beside the kit folder, so the review page and the catalog reach the same one.
const ROUTE = new URL("../api/preferences", import.meta.url);
const DARK_QUERY = "(prefers-color-scheme: dark)";

let current = { ...DEFAULT_PREFERENCES };
let listening = false;

/** A choice with every missing or invalid value replaced by its default. */
export function normalizePreferences(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    theme: THEMES.includes(source.theme) ? source.theme : DEFAULT_PREFERENCES.theme,
    density: DENSITIES.includes(source.density) ? source.density : DEFAULT_PREFERENCES.density
  };
}

function systemTheme() {
  try {
    return globalThis.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function remember(preferences) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A browser that refuses storage still shows the choice; the next load reads it from the review app.
  }
}

function remembered() {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "null");
    return stored ? normalizePreferences(stored) : null;
  } catch {
    return null;
  }
}

// The browser's theme color is the chrome token of the theme that applies now.
function updateThemeColor(root) {
  const meta = root.ownerDocument?.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const chrome = getComputedStyle(root).getPropertyValue("--prism-color-chrome").trim();
  if (chrome) meta.setAttribute("content", chrome);
}

/** The choice that applies to the page now. */
export function currentPreferences() {
  return { ...current };
}

/** Sets data-theme-choice, data-theme, data-density, and the theme color on the root element, and returns the applied choice. */
export function applyPreferences(preferences, root = globalThis.document?.documentElement) {
  current = normalizePreferences(preferences);
  if (!root) return currentPreferences();
  root.setAttribute("data-theme-choice", current.theme);
  root.setAttribute("data-theme", current.theme === "system" ? systemTheme() : current.theme);
  root.setAttribute("data-density", current.density);
  updateThemeColor(root);
  return currentPreferences();
}

// While the choice is system, the page follows the operating system's color scheme as it changes, without a reload.
function listen() {
  if (listening || !globalThis.matchMedia) return;
  listening = true;
  const query = globalThis.matchMedia(DARK_QUERY);
  query.addEventListener?.("change", () => {
    if (current.theme === "system") applyPreferences(current);
  });
  // A theme color read before the stylesheets applied is read again once they have.
  if (globalThis.document?.readyState !== "complete") globalThis.addEventListener?.("load", () => applyPreferences(current), { once: true });
}

/** Applies this browser's last choice, which boot.js already showed, and follows the operating system from now on. */
export function startPreferences() {
  listen();
  return applyPreferences(remembered() ?? current);
}

/** Applies the review app's stored choice, which wins over this browser's, and remembers it for the next first paint. */
export function adoptStoredPreferences(stored) {
  listen();
  const preferences = normalizePreferences(stored);
  remember(preferences);
  return applyPreferences(preferences);
}

/** Reads the review app's stored choice again and applies it; an unreachable review app keeps the choice the page shows. */
export async function loadPreferences({ fetch: request = globalThis.fetch } = {}) {
  try {
    const response = await request(ROUTE, { cache: "no-store" });
    if (!response.ok) return currentPreferences();
    return adoptStoredPreferences(await response.json());
  } catch {
    return currentPreferences();
  }
}

/** Applies a change at once, stores it in the review app, and returns the stored choice; a refused change throws after the page shows it. */
export async function savePreferences(change, { fetch: request = globalThis.fetch } = {}) {
  const next = applyPreferences({ ...current, ...change });
  remember(next);
  const response = await request(ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });
  if (!response.ok) throw new Error(`The review app did not store the appearance (${response.status}).`);
  return adoptStoredPreferences(await response.json());
}
