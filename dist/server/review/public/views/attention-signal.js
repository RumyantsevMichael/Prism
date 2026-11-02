// Signals outside the page that a question waits on the user: the tab title, the tab icon, an installed app's badge, and,
// when the user turns them on, system notifications.

export function signalTitle(base, count) {
  return count > 0 ? `(${count}) ${base}` : base;
}

// The favicon gains a dot in its top right corner, the way chat and mail tabs mark unread items.
export function badgedIcon(svg) {
  return String(svg).replace(/<\/svg>\s*$/, '<circle cx="25.5" cy="6.5" r="6" fill="#e5484d" stroke="#ffffff" stroke-width="1.5"/></svg>');
}

// A notification is for a question that arrived while the user looks elsewhere, so the first count a page sees never notifies.
export function shouldNotify({ previous, count, permission, visible }) {
  return previous !== null && count > previous && permission === "granted" && !visible;
}

export function notificationText(count, project) {
  return { title: count === 1 ? "A question waits for you" : `${count} questions wait for you`, body: `Prism · ${project}` };
}

// What the Attention page offers for system notifications, from the browser's permission for this page.
export function notifyControl(permission) {
  if (permission === "granted") return '<p class="notify-control muted">Desktop notifications are on for new questions while this page is in the background.</p>';
  if (permission === "denied") return '<p class="notify-control muted">Desktop notifications are blocked for this page in the browser settings.</p>';
  if (permission === "default") return '<p class="notify-control"><button type="button" class="tool-button" data-notify>Notify me about new questions</button> <span class="muted">A desktop notification appears when a question arrives while this page is in the background.</span></p>';
  return "";
}
