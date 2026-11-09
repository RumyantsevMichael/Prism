// The time words of a claim, shared by prism-claim's forms, and the timer that updates a shown claim each minute.

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The time left before `expiresAt`, or since it passed, in words: `<n> min left` in whole minutes rounded up below an hour, `<n> h left` in rounded hours
 * below 48 hours, then `<n> days left`; a passed time reads `Expired <n> min ago` in whole minutes rounded down, or `h`, or `days`, at the same steps.
 */
export function timeLeft(expiresAt, now = Date.now()) {
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end)) return { text: "", expired: false, left: NaN };
  const left = end - now;
  if (left > 0) {
    if (left < HOUR) return { text: `${Math.ceil(left / MINUTE)} min left`, expired: false, left };
    if (left < 48 * HOUR) return { text: `${Math.round(left / HOUR)} h left`, expired: false, left };
    return { text: `${Math.round(left / DAY)} days left`, expired: false, left };
  }
  const ago = -left;
  if (ago < HOUR) return { text: `Expired ${Math.floor(ago / MINUTE)} min ago`, expired: true, left };
  if (ago < 48 * HOUR) return { text: `Expired ${Math.floor(ago / HOUR)} h ago`, expired: true, left };
  return { text: `Expired ${Math.floor(ago / DAY)} days ago`, expired: true, left };
}

/** The share of the lease from `renewedAt` to `expiresAt` that is left, in whole percent from 0 to 100, or null without both times. */
export function leaseLeft(renewedAt, expiresAt, now = Date.now()) {
  const start = Date.parse(renewedAt);
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.min(100, Math.max(0, Math.round(((end - now) / (end - start)) * 100)));
}

/** A claim's start in words: the time of day for today, and the day and time otherwise. */
export function sinceText(claimedAt, now = Date.now()) {
  const at = Date.parse(claimedAt);
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now).toDateString() === date.toDateString();
  return today ? `since ${time}` : `since ${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

/**
 * Calls `update` every minute until the returned function is called.
 * Each shown claim keeps its own timer from the moment it appears, so its words change a minute after they were last written.
 */
export function everyMinute(update) {
  const timer = setInterval(update, MINUTE);
  return () => clearInterval(timer);
}
