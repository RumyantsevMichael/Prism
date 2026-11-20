// Generated from src/server/review/viewer-hub.mts by scripts/native-build/compile.mjs.
import { randomBytes } from "node:crypto";
const HEARTBEAT_MS = 15 * 1e3;
const MEMBER_LIMIT = 64;
const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-store",
  Connection: "keep-alive",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
};
const TAB_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
function writeEvent(response, event, data) {
  response.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
}
const streams = /* @__PURE__ */ new WeakSet();
const isEventStream = (response) => streams.has(response);
function openEventStream(response, onGone, heartbeatMs = HEARTBEAT_MS) {
  streams.add(response);
  response.writeHead(200, STREAM_HEADERS);
  response.flushHeaders();
  const heartbeat = setInterval(() => {
    try {
      response.write(": keep-alive\n\n");
    } catch {
      onGone();
      response.destroy();
    }
  }, heartbeatMs);
  heartbeat.unref();
  response.once("close", onGone);
  return heartbeat;
}
function createViewerHub({ heartbeatMs = HEARTBEAT_MS, onChange = null } = {}) {
  const streams2 = /* @__PURE__ */ new Map();
  function drop(id) {
    const stream = streams2.get(id);
    if (!stream) return;
    clearInterval(stream.heartbeat);
    streams2.delete(id);
    if (stream.members.size) onChange?.();
  }
  function deliver(stream, event, data) {
    try {
      writeEvent(stream.response, event, data);
    } catch {
      drop(stream.id);
      stream.response.destroy();
    }
  }
  return {
    /** Opens a stream on response and names it in its first event, `hub`, which the opening tab passes to the others. */
    open(response) {
      const id = randomBytes(18).toString("base64url");
      const stream = { id, response, members: /* @__PURE__ */ new Map(), heartbeat: null };
      streams2.set(id, stream);
      stream.heartbeat = openEventStream(response, () => drop(id), heartbeatMs);
      writeEvent(response, "hub", { stream: id });
      return id;
    },
    /** Adds a tab to a stream for a project; false when the stream is gone, the tab id is malformed, or the stream is full. */
    join(id, tab, project, writable) {
      const stream = streams2.get(id);
      if (!stream || typeof tab !== "string" || !TAB_PATTERN.test(tab)) return false;
      if (!stream.members.has(tab) && stream.members.size >= MEMBER_LIMIT) return false;
      stream.members.set(tab, { project, writable: Boolean(writable) });
      onChange?.();
      return true;
    },
    leave(id, tab) {
      if (streams2.get(id)?.members.delete(tab)) onChange?.();
    },
    /** Writes one project event to every stream with a tab of that project, once per stream. */
    notify(project, event, data) {
      for (const stream of [...streams2.values()]) {
        if ([...stream.members.values()].some((member) => member.project === project)) deliver(stream, event, { project, data });
      }
    },
    /** Writes one project event to one stream only, such as the session snapshot a joining tab starts from. */
    send(id, project, event, data) {
      const stream = streams2.get(id);
      if (stream) deliver(stream, event, { project, data });
    },
    /** The tabs of a project across every stream, or only those that carry a write session. */
    count(project, { writable = false } = {}) {
      let count = 0;
      for (const stream of streams2.values()) {
        for (const member of stream.members.values()) if (member.project === project && (!writable || member.writable)) count += 1;
      }
      return count;
    },
    streamCount: () => streams2.size,
    close() {
      for (const stream of [...streams2.values()]) {
        drop(stream.id);
        stream.response.end();
      }
    }
  };
}
export {
  createViewerHub,
  isEventStream,
  openEventStream,
  writeEvent
};
