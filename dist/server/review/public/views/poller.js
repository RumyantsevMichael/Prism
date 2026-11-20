// Generated from src/server/review/public/views/poller.ts by scripts/native-build/compile.mjs.
const POLL_DEADLINE_MS = 8e3;
const REQUEST_DEADLINE_MS = 3e4;
function deadline(ms = REQUEST_DEADLINE_MS) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("The request took too long.", "TimeoutError")), ms);
  return controller.signal;
}
function createPoller({ run, interval, whileHidden = false, doc = globalThis.document, setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = (id) => clearTimeout(id) }) {
  let timer = null;
  let running = null;
  let again = false;
  let started = false;
  const hidden = () => doc?.visibilityState === "hidden";
  const active = () => whileHidden ? hidden() : !hidden();
  function cancel() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule(result) {
    cancel();
    if (!started || !active()) return;
    const delay = typeof interval === "function" ? interval(result) : interval;
    timer = setTimer(() => {
      timer = null;
      if (active()) tick();
    }, delay);
  }
  function tick() {
    cancel();
    running = Promise.resolve().then(run).then((result) => ({ result }), () => ({ result: void 0 })).then(({ result }) => {
      running = null;
      if (again) {
        again = false;
        return tick();
      }
      schedule(result);
      return result;
    });
    return running;
  }
  function onVisibility() {
    if (started && active() && !running) tick();
  }
  return {
    start() {
      if (started) return running ?? Promise.resolve();
      started = true;
      doc?.addEventListener?.("visibilitychange", onVisibility);
      return active() ? tick() : Promise.resolve();
    },
    stop() {
      started = false;
      cancel();
      doc?.removeEventListener?.("visibilitychange", onVisibility);
    },
    now() {
      if (running) {
        again = true;
        return running;
      }
      return tick();
    },
    get busy() {
      return running !== null;
    }
  };
}
function coalesce(fn) {
  let running = null;
  let again = false;
  const call = () => {
    if (running) {
      again = true;
      return running;
    }
    running = Promise.resolve().then(fn).finally(() => {
      running = null;
      if (again) {
        again = false;
        void call();
      }
    });
    return running;
  };
  return call;
}
export {
  POLL_DEADLINE_MS,
  REQUEST_DEADLINE_MS,
  coalesce,
  createPoller,
  deadline
};
