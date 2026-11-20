// Generated from src/server/review/public/kit/boot.ts by scripts/native-build/compile.mjs.
(function applyLastChoice() {
  var root = document.documentElement;
  var choice = { theme: "system", density: "compact" };
  try {
    var stored = JSON.parse(window.localStorage.getItem("prism-preferences") || "null");
    if (stored && ["system", "light", "dark"].indexOf(stored.theme) >= 0) choice.theme = stored.theme;
    if (stored && ["compact", "comfortable"].indexOf(stored.density) >= 0) choice.density = stored.density;
  } catch (error) {
  }
  var dark = false;
  try {
    dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (error) {
    dark = false;
  }
  root.setAttribute("data-theme-choice", choice.theme);
  root.setAttribute("data-theme", choice.theme === "system" ? dark ? "dark" : "light" : choice.theme);
  root.setAttribute("data-density", choice.density);
})();
