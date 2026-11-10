// Keeps the page in step with the user's preferences: the theme and density it applies to the root element, and every other registered preference
// the views read, such as the roadmap's view or the sidebar's state.
// The review app stores the preferences for the user (GET and PUT api/preferences), because browser storage is separate for every port;
// this browser's copy of the last preferences lets boot.js apply the appearance before the first paint and the views start from the last choice.
import { DEFAULT_PREFERENCES, normalizePreferences, PREFERENCES } from "./preference-registry.js";

export { DEFAULT_PREFERENCES, normalizePreferences, PREFERENCES };
export const THEMES = PREFERENCES.theme.values;
export const DENSITIES = PREFERENCES.density.values;

const STORAGE_KEY = "prism-preferences";
// The route sits beside the kit folder, so the review page and the catalog reach the same one.
const ROUTE = new URL("../api/preferences", import.meta.url);
const DARK_QUERY = "(prefers-color-scheme: dark)";
// A page waits this long at most for the review app's stored preferences before it renders with this browser's copy.
const STORED_WAIT_MS = 1500;

let current = { ...DEFAULT_PREFERENCES };
let listening = false;
let stored = false;
let markStored;
const storedArrived = new Promise((resolve) => {
  markStored = resolve;
});
const listeners = new Set();
// Each save is numbered, so the answer to an older save never undoes a newer change the page already shows.
let saves = 0;

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
    const value = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "null");
    return value ? normalizePreferences(value) : null;
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

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Every listener hears the keys whose values changed, once per change.
function announce(previous) {
  const changed = Object.keys(current).filter((key) => !same(previous[key], current[key]));
  if (!changed.length) return;
  for (const listener of listeners) {
    try {
      listener(changed, currentPreferences());
    } catch {
      // One failing view does not keep the others from hearing the change.
    }
  }
}

/** The preferences that apply to the page now. */
export function currentPreferences() {
  return structuredClone(current);
}

/** The value of one registered preference now. */
export function preference(key) {
  if (!Object.hasOwn(PREFERENCES, key)) throw new Error(`${key} is not a preference.`);
  return structuredClone(current[key]);
}

/** Calls listener(changedKeys, preferences) whenever a preference changes, in this window; returns a function that stops it. */
export function onPreferencesChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Resolves once the review app's stored preferences apply, or after a short wait when the review app does not answer. */
export function preferencesReady() {
  if (stored) return Promise.resolve(currentPreferences());
  return Promise.race([storedArrived, new Promise((resolve) => setTimeout(resolve, STORED_WAIT_MS))]).then(currentPreferences);
}

/** Sets data-theme-choice, data-theme, data-density, and the theme color on the root element, and returns the applied preferences. */
export function applyPreferences(preferences, root = globalThis.document?.documentElement) {
  const previous = current;
  current = normalizePreferences({ ...current, ...preferences });
  if (root) {
    root.setAttribute("data-theme-choice", current.theme);
    root.setAttribute("data-theme", current.theme === "system" ? systemTheme() : current.theme);
    root.setAttribute("data-density", current.density);
    updateThemeColor(root);
  }
  announce(previous);
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

/** Applies this browser's last preferences, whose appearance boot.js already showed, and follows the operating system from now on. */
export function startPreferences() {
  listen();
  return applyPreferences(remembered() ?? current);
}

/** Applies the review app's stored preferences, which win over this browser's, and remembers them for the next first paint. */
export function adoptStoredPreferences(value) {
  listen();
  const preferences = normalizePreferences(value);
  remember(preferences);
  const applied = applyPreferences(preferences);
  stored = true;
  markStored(applied);
  return applied;
}

/** Reads the review app's stored preferences again and applies them; an unreachable review app keeps the preferences the page shows. */
export async function loadPreferences({ fetch: request = globalThis.fetch } = {}) {
  try {
    const response = await request(ROUTE, { cache: "no-store" });
    if (!response.ok) return currentPreferences();
    return adoptStoredPreferences(await response.json());
  } catch {
    return currentPreferences();
  }
}

/** Applies a change at once, stores it in the review app, and returns the stored preferences; a refused change throws after the page shows it. */
export async function savePreferences(change, { fetch: request = globalThis.fetch } = {}) {
  const next = applyPreferences({ ...current, ...change });
  remember(next);
  const save = ++saves;
  const response = await request(ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });
  if (!response.ok) throw new Error(`The review app did not store the preference (${response.status}).`);
  const answer = await response.json();
  return save === saves ? adoptStoredPreferences(answer) : currentPreferences();
}

/** Stores one preference the way savePreferences does; a review app that refuses it leaves the change applied in this window only. */
export function setPreference(key, value, options) {
  if (!Object.hasOwn(PREFERENCES, key)) throw new Error(`${key} is not a preference.`);
  return savePreferences({ [key]: value }, options);
}
