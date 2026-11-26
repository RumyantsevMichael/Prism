// Generated from src/server/review/public/views/event-relay.ts by scripts/native-build/compile.mjs.
const EVENTS = ["session", "action", "notice", "records", "code"];
const JOIN_RETRY_MS = 2e3;
function tabId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}
function relayScope(href) {
  const key = new URL("./", href).pathname;
  return { key, scope: key.replace(/\/[pw]\/[0-9a-f]{16}\/$/, "/") };
}
function createEventRelay({
  href = location.href,
  streamUrl = "./api/events/shared",
  join,
  leave,
  onEvent,
  onStatus = () => {
  },
  locks = globalThis.navigator?.locks,
  Channel = globalThis.BroadcastChannel,
  Source = globalThis.EventSource
}) {
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
  const watched = /* @__PURE__ */ new Map();
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
    void locks.request(`prism-review-tab:${scope}${other}`, () => {
      const last = watched.get(other);
      watched.delete(other);
      if (last) void Promise.resolve(leave(last, other, { keepalive: false })).catch(() => {
      });
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
        return new Promise(() => {
        });
      }).catch(resolve);
    });
    void locks.request(`prism-review-events:${scope}`, () => {
      lead();
      return new Promise(() => {
      });
    }).catch(() => lead());
    channel.postMessage({ type: "hello" });
  } else {
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
      if (joined) void Promise.resolve(leave(joined, tab, { keepalive: true })).catch(() => {
      });
      source?.close();
      channel?.close();
    }
  };
}
export {
  createEventRelay,
  relayScope
};
