import { randomBytes } from "node:crypto";

// A browser allows six HTTP/1.1 connections to one host, and the review app serves every project from one host, so a browser holds one event stream for all its tabs.
// One tab opens the stream; every tab, that one included, joins it for its own project with its own write session, so a write session never leaves its tab.
// An event of a project reaches each stream that a tab of that project joined, once per stream, as { project, data }, where project is the page path the tab is on.
const HEARTBEAT_MS = 15 * 1000;
// A stream relays for the tabs of one browser, so a few dozen members is already far more than a person opens.
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

export function writeEvent(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function openEventStream(response, onGone, heartbeatMs = HEARTBEAT_MS) {
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

/** The streams of one origin, the review app or a session server, and the tabs that joined each for a project. */
// onChange runs whenever the tabs that joined change, as when a tab joins or leaves or its browser closes the stream.
export function createViewerHub({ heartbeatMs = HEARTBEAT_MS, onChange = null } = {}) {
  const streams = new Map();

  function drop(id) {
    const stream = streams.get(id);
    if (!stream) return;
    clearInterval(stream.heartbeat);
    streams.delete(id);
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
      const stream = { id, response, members: new Map(), heartbeat: null };
      streams.set(id, stream);
      stream.heartbeat = openEventStream(response, () => drop(id), heartbeatMs);
      writeEvent(response, "hub", { stream: id });
      return id;
    },
    /** Adds a tab to a stream for a project; false when the stream is gone, the tab id is malformed, or the stream is full. */
    join(id, tab, project, writable) {
      const stream = streams.get(id);
      if (!stream || typeof tab !== "string" || !TAB_PATTERN.test(tab)) return false;
      if (!stream.members.has(tab) && stream.members.size >= MEMBER_LIMIT) return false;
      stream.members.set(tab, { project, writable: Boolean(writable) });
      onChange?.();
      return true;
    },
    leave(id, tab) {
      if (streams.get(id)?.members.delete(tab)) onChange?.();
    },
    /** Writes one project event to every stream with a tab of that project, once per stream. */
    notify(project, event, data) {
      for (const stream of [...streams.values()]) {
        if ([...stream.members.values()].some((member) => member.project === project)) deliver(stream, event, { project, data });
      }
    },
    /** Writes one project event to one stream only, such as the session snapshot a joining tab starts from. */
    send(id, project, event, data) {
      const stream = streams.get(id);
      if (stream) deliver(stream, event, { project, data });
    },
    /** The tabs of a project across every stream, or only those that carry a write session. */
    count(project, { writable = false } = {}) {
      let count = 0;
      for (const stream of streams.values()) {
        for (const member of stream.members.values()) if (member.project === project && (!writable || member.writable)) count += 1;
      }
      return count;
    },
    streamCount: () => streams.size,
    close() {
      for (const stream of [...streams.values()]) {
        drop(stream.id);
        stream.response.end();
      }
    }
  };
}
