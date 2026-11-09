// A browser opens at most six connections to the review app for all its tabs together, so a page never lets a check pile up behind a slow answer.
// Each kind of check has at most one request in flight, the next one is scheduled only after the answer, and a hidden tab checks nothing until it is shown again.

// How long a periodic check may wait for its answer before it counts as failed, and how long any other request may take.
export const POLL_DEADLINE_MS = 8000;
export const REQUEST_DEADLINE_MS = 30000;

/** A signal that aborts a request after `ms`, so a request the browser keeps queued fails instead of waiting forever. */
export function deadline(ms = REQUEST_DEADLINE_MS) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("The request took too long.", "TimeoutError")), ms);
  return controller.signal;
}

/**
 * Runs `run` now and then again `interval` milliseconds after each run settles, where `interval` may be a function of the last result.
 * `now()` asks for a run at once: while one is in flight it runs once more after that one instead of starting a second request.
 * While the document is hidden no run starts on the timer; showing it runs once at once and resumes the schedule.
 */
export function createPoller({ run, interval, doc = globalThis.document, setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = (id) => clearTimeout(id) }) {
  let timer = null;
  let running = null;
  let again = false;
  let started = false;
  const hidden = () => doc?.visibilityState === "hidden";

  function cancel() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule(result) {
    cancel();
    if (!started || hidden()) return;
    const delay = typeof interval === "function" ? interval(result) : interval;
    timer = setTimer(() => {
      timer = null;
      if (!hidden()) tick();
    }, delay);
  }

  function tick() {
    cancel();
    running = Promise.resolve()
      .then(run)
      .then((result) => ({ result }), () => ({ result: undefined }))
      .then(({ result }) => {
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
    if (started && !hidden() && !running) tick();
  }

  return {
    start() {
      if (started) return running ?? Promise.resolve();
      started = true;
      doc?.addEventListener?.("visibilitychange", onVisibility);
      return hidden() ? Promise.resolve() : tick();
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

/** Wraps an async function so calls made while it runs share one follow-up run instead of each starting their own. */
export function coalesce(fn) {
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
