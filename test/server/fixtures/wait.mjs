import { isDeepStrictEqual } from "node:util";

// The longest a test waits for a state that should arrive: a ceiling for slow runners, never a guess at how fast the work is.
export const WAIT_MS = 15000;
// The longest a test waits for a component index to become ready, which builds and copies files on slow runners too.
export const READY_WAIT_MS = 30000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads `read` until its value is accepted and returns that value, or returns the last reading after `timeout`
 * so the caller's own assertion reports it. `accept` is the expected value, compared deeply, or a predicate;
 * without it any truthy value is accepted. A read that throws is retried until the timeout, then its error is thrown.
 */
export async function settled(read, accept = Boolean, { timeout = WAIT_MS, every = 50 } = {}) {
  const accepted = typeof accept === "function" ? accept : (value) => isDeepStrictEqual(value, accept);
  const until = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = await read();
    } catch (error) {
      if (Date.now() > until) throw error;
      await delay(every);
      continue;
    }
    if (accepted(value) || Date.now() > until) return value;
    await delay(every);
  }
}

/**
 * A fixed pause, for the few waits nothing can be awaited for: a check that something does not happen, or a pace the test sets itself.
 * The reason is required so that every fixed pause says why it cannot wait for an event.
 */
export function pause(ms, reason) {
  if (typeof reason !== "string" || reason.trim() === "") throw new TypeError("A fixed pause needs its reason.");
  return delay(ms);
}

/**
 * Resolves once the page has loaded its fonts, finished its running transitions and finite animations, and drawn two frames,
 * so layout, resize observers, and the kit's own first-frame work have run: the event a test waits for after it mounts
 * or changes markup, instead of a fixed pause. An endless animation, such as a spinner, is not waited for.
 */
export function repainted(page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    await frame();
    const finite = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => {})));
    await frame();
    await frame();
  });
}
