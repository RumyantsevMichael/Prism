// Generated from src/server/review/public/kit/claim-time.ts by scripts/native-build/compile.mjs.
const MINUTE = 6e4;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
function timeLeft(expiresAt, now = Date.now()) {
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
function leaseLeft(renewedAt, expiresAt, now = Date.now()) {
  const start = Date.parse(renewedAt);
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.min(100, Math.max(0, Math.round((end - now) / (end - start) * 100)));
}
function sinceText(claimedAt, now = Date.now()) {
  const at = Date.parse(claimedAt);
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  const time = date.toLocaleTimeString(void 0, { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now).toDateString() === date.toDateString();
  return today ? `since ${time}` : `since ${date.toLocaleDateString(void 0, { day: "numeric", month: "short" })} ${time}`;
}
function agoText(at, now = Date.now()) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "";
  const ago = Math.max(0, now - time);
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < 48 * HOUR) return `${Math.floor(ago / HOUR)} h ago`;
  return `${Math.floor(ago / DAY)} days ago`;
}
function exactTime(at) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString(void 0, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function everyMinute(update) {
  const timer = setInterval(update, MINUTE);
  return () => clearInterval(timer);
}
export {
  agoText,
  everyMinute,
  exactTime,
  leaseLeft,
  sinceText,
  timeLeft
};
