// Generated from src/server/review/public/views/attention-signal.ts by scripts/native-build/compile.mjs.
function signalTitle(base, count) {
  return count > 0 ? `(${count}) ${base}` : base;
}
function badgeColors(root = globalThis.document?.documentElement) {
  const style = root ? getComputedStyle(root) : null;
  const read = (name) => style?.getPropertyValue(name).trim() || "currentColor";
  return { fill: read("--prism-color-danger"), stroke: read("--prism-color-surface") };
}
function badgedIcon(svg, { fill, stroke } = badgeColors()) {
  return String(svg).replace(/<\/svg>\s*$/, `<circle cx="25.5" cy="6.5" r="6" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/></svg>`);
}
function shouldNotify({ previous, count, permission, visible }) {
  return previous !== null && count > previous && permission === "granted" && !visible;
}
function notificationText(count, project) {
  return { title: count === 1 ? "A question waits for you" : `${count} questions wait for you`, body: `Prism \xB7 ${project}` };
}
function notifyControl(permission) {
  if (permission === "granted") return '<p class="notify-control muted">Desktop notifications are on for new questions while this page is in the background.</p>';
  if (permission === "denied") return '<p class="notify-control muted">Desktop notifications are blocked for this page in the browser settings.</p>';
  if (permission === "default") return '<p class="notify-control"><prism-button size="sm" data-notify>Notify me about new questions</prism-button> <span class="muted">A desktop notification appears when a question arrives while this page is in the background.</span></p>';
  return "";
}
export {
  badgeColors,
  badgedIcon,
  notificationText,
  notifyControl,
  shouldNotify,
  signalTitle
};
