// Generated from src/server/review/public/kit/preferences.ts by scripts/native-build/compile.mjs.
import { DEFAULT_PREFERENCES, normalizePreferences, PREFERENCES } from "./preference-registry.js";
const THEMES = PREFERENCES.theme.values;
const DENSITIES = PREFERENCES.density.values;
const STORAGE_KEY = "prism-preferences";
const ROUTE = new URL("../api/preferences", import.meta.url);
const DARK_QUERY = "(prefers-color-scheme: dark)";
const STORED_WAIT_MS = 1500;
let current = { ...DEFAULT_PREFERENCES };
let listening = false;
let stored = false;
let markStored;
const storedArrived = new Promise((resolve) => {
  markStored = resolve;
});
const listeners = /* @__PURE__ */ new Set();
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
function updateThemeColor(root) {
  const meta = root.ownerDocument?.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const chrome = getComputedStyle(root).getPropertyValue("--prism-color-chrome").trim();
  if (chrome) meta.setAttribute("content", chrome);
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function announce(previous) {
  const changed = Object.keys(current).filter((key) => !same(previous[key], current[key]));
  if (!changed.length) return;
  for (const listener of listeners) {
    try {
      listener(changed, currentPreferences());
    } catch {
    }
  }
}
function currentPreferences() {
  return structuredClone(current);
}
function preference(key) {
  if (!Object.hasOwn(PREFERENCES, key)) throw new Error(`${key} is not a preference.`);
  return structuredClone(current[key]);
}
function onPreferencesChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function preferencesReady() {
  if (stored) return Promise.resolve(currentPreferences());
  return Promise.race([storedArrived, new Promise((resolve) => setTimeout(resolve, STORED_WAIT_MS))]).then(currentPreferences);
}
function applyPreferences(preferences, root = globalThis.document?.documentElement) {
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
function listen() {
  if (listening || !globalThis.matchMedia) return;
  listening = true;
  const query = globalThis.matchMedia(DARK_QUERY);
  query.addEventListener?.("change", () => {
    if (current.theme === "system") applyPreferences(current);
  });
  if (globalThis.document?.readyState !== "complete") globalThis.addEventListener?.("load", () => applyPreferences(current), { once: true });
}
function startPreferences() {
  listen();
  return applyPreferences(remembered() ?? current);
}
function adoptStoredPreferences(value) {
  listen();
  const preferences = normalizePreferences(value);
  remember(preferences);
  const applied = applyPreferences(preferences);
  stored = true;
  markStored(applied);
  return applied;
}
async function loadPreferences({ fetch: request = globalThis.fetch } = {}) {
  try {
    const response = await request(ROUTE, { cache: "no-store" });
    if (!response.ok) return currentPreferences();
    return adoptStoredPreferences(await response.json());
  } catch {
    return currentPreferences();
  }
}
async function savePreferences(change, { fetch: request = globalThis.fetch } = {}) {
  const next = applyPreferences({ ...current, ...change });
  remember(next);
  const save = ++saves;
  const response = await request(ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });
  if (!response.ok) throw new Error(`The review app did not store the preference (${response.status}).`);
  const answer = await response.json();
  return save === saves ? adoptStoredPreferences(answer) : currentPreferences();
}
function setPreference(key, value, options) {
  if (!Object.hasOwn(PREFERENCES, key)) throw new Error(`${key} is not a preference.`);
  return savePreferences({ [key]: value }, options);
}
export {
  DEFAULT_PREFERENCES,
  DENSITIES,
  PREFERENCES,
  THEMES,
  adoptStoredPreferences,
  applyPreferences,
  currentPreferences,
  loadPreferences,
  normalizePreferences,
  onPreferencesChange,
  preference,
  preferencesReady,
  savePreferences,
  setPreference,
  startPreferences
};
