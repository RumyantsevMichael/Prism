// A browser opens at most six HTTP/1.1 connections to one host, and the review app serves every project from one host, so one event stream per tab would exhaust them.
// The tabs of one review origin share one stream instead: the tab that holds the leader lock opens it and relays its events to the others over a broadcast channel.
// Every tab joins the stream itself, with its own write session, so a write session never leaves its tab, and the server counts each tab as before.
// When the leader closes, its lock passes to a waiting tab, which opens a new stream, and every tab joins that one.
//
// Messages on the channel:
//   { type: "hello" }                      a tab started and asks the leader for the stream
//   { type: "stream", id, open }           the leader's stream, by the id the server gave it, and whether it is connected
//   { type: "event", name, data }          an event of the stream, whose data names the project page it belongs to
//   { type: "joined", tab, stream }        a tab joined, so the leader leaves the stream for it once the tab's own lock is free

const EVENTS = ["session", "action", "notice"];
const JOIN_RETRY_MS = 2000;

function tabId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

/** The page path a tab's events are addressed to, and the app-wide scope its tabs share, from the page address. */
export function relayScope(href) {
  const key = new URL("./", href).pathname;
  return { key, scope: key.replace(/\/[pw]\/[0-9a-f]{16}\/$/, "/") };
}

/**
 * Connects this tab to its origin's shared event stream.
 * `join(stream, tab)` and `leave(stream, tab, { keepalive })` ask the server; join resolves true once the tab is a member.
 * `onEvent(name, data)` receives this page's events, and `onStatus({ open, joined })` the stream's state as this tab sees it.
 */
export function createEventRelay({ href = location.href, streamUrl = "./api/events/shared", join, leave, onEvent, onStatus = () => {},
  locks = globalThis.navigator?.locks, Channel = globalThis.BroadcastChannel, Source = globalThis.EventSource }) {
  const { key, scope } = relayScope(href);
  const tab = tabId();
  const shared = Boolean(locks?.request && Channel);
  const channel = shared ? new Channel(`prism-review-events:${scope}`) : null;
  let leader = false;
  let source = null;
  let stream = null;
  let open = false;
  let joined = null;
  let joining = null;
  let retry = 0;
  let closed = false;
  // The leader's record of each other tab and the stream it last joined, so it can leave for a tab that went away without saying so.
  const watched = new Map();
  let ownLock = Promise.resolve();

  const status = () => onStatus({ open, joined: open && joined === stream, leader });

  function publish(message) {
    channel?.postMessage(message);
    receive(message);
  }

  function receive(message) {
    if (closed || !message || typeof message !== "object") return;
    if (message.type === "stream") {
      stream = message.id ?? null;
      open = Boolean(message.open);
      if (stream && open && joined !== stream) void enter(stream);
      status();
    } else if (message.type === "event") {
      if (message.data?.project === key) onEvent(message.name, message.data.data);
    } else if (message.type === "hello") {
      if (leader && stream) channel?.postMessage({ type: "stream", id: stream, open });
    } else if (message.type === "joined") {
      if (leader && message.tab !== tab) watch(message.tab, message.stream);
    }
  }

  async function enter(id) {
    if (joining === id) return;
    joining = id;
    clearTimeout(retry);
    const ok = await Promise.resolve(join(id, tab)).catch(() => false);
    if (joining !== id) return;
    joining = null;
    if (closed) return;
    if (!ok) {
      // A stream that closed is replaced by the leader's next one; any other failure tries the same stream again shortly.
      retry = setTimeout(() => {
        if (stream === id && open && joined !== id) void enter(id);
      }, JOIN_RETRY_MS);
      return;
    }
    joined = id;
    status();
    await ownLock;
    channel?.postMessage({ type: "joined", tab, stream: id });
  }

  function watch(other, id) {
    const known = watched.has(other);
    watched.set(other, id);
    if (known) return;
    // The tab holds its own lock while it lives, so the leader is granted it only once the tab closed or crashed.
    void locks.request(`prism-review-tab:${scope}${other}`, () => {
      const last = watched.get(other);
      watched.delete(other);
      if (last) void Promise.resolve(leave(last, other, { keepalive: false })).catch(() => {});
    });
  }

  function connect() {
    source?.close();
    source = new Source(streamUrl);
    source.addEventListener("hub", (event) => {
      try {
        publish({ type: "stream", id: JSON.parse(event.data).stream, open: true });
      } catch {
      }
    });
    source.addEventListener("error", () => {
      // The browser reconnects the stream on its own unless the server refused it; a reconnected stream gets a new id and every tab joins it again.
      publish({ type: "stream", id: stream, open: false });
    });
    for (const name of EVENTS) {
      source.addEventListener(name, (event) => {
        try {
          publish({ type: "event", name, data: JSON.parse(event.data) });
        } catch {
        }
      });
    }
  }

  function lead() {
    if (closed) return;
    leader = true;
    connect();
    status();
  }

  if (shared) {
    channel.addEventListener("message", (event) => receive(event.data));
    ownLock = new Promise((resolve) => {
      void locks.request(`prism-review-tab:${scope}${tab}`, () => {
        resolve();
        return new Promise(() => {});
      }).catch(resolve);
    });
    // The leader lock is held until the tab closes; a tab that cannot take it now waits, and takes over when the leader goes.
    void locks.request(`prism-review-events:${scope}`, () => {
      lead();
      return new Promise(() => {});
    }).catch(() => lead());
    channel.postMessage({ type: "hello" });
  } else {
    // Without locks or a broadcast channel the tab keeps a stream of its own, as each tab did before streams were shared.
    lead();
  }

  return {
    tab,
    key,
    get leader() {
      return leader;
    },
    /** Whether the stream that carries this page's events is connected, which proves the app is running. */
    get open() {
      return open;
    },
    /** Opens the stream again after the server refused it, or asks the leader for it. */
    reconnect() {
      if (leader && (!source || source.readyState === 2)) connect();
      else if (!leader) channel?.postMessage({ type: "hello" });
    },
    /** Leaves the stream as the tab goes away; the leader's stream closes with its tab. */
    close() {
      if (closed) return;
      closed = true;
      if (joined) void Promise.resolve(leave(joined, tab, { keepalive: true })).catch(() => {});
      source?.close();
      channel?.close();
    }
  };
}
