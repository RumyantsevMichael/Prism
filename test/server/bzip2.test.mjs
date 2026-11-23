import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Bzip2Error, bunzip2, bunzip2InWorker } from "../../dist/server/session/bzip2.mjs";

// The bzip2 decoder of registry installs, checked against the system bzip2 on data that exercises every step of the format.

const bzip2 = (data, level = 9) => {
  const run = spawnSync("bzip2", [`-${level}`, "-c"], { input: data, maxBuffer: 1 << 28 });
  return run.status === 0 ? run.stdout : null;
};
const noBzip2 = bzip2(Buffer.from("x")) === null ? "needs the system bzip2" : false;
const LIMIT = 1 << 28;

// Text with short and long runs of equal bytes, so the initial run-length step and the run symbols of the second both occur.
function mixed(size) {
  const parts = [];
  let length = 0;
  let seed = 7;
  while (length < size) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const pick = seed % 4;
    const part = pick === 0 ? Buffer.alloc(1 + (seed >>> 8) % 600, 0x61 + (seed % 3)) : pick === 1 ? randomBytes(1 + (seed >>> 8) % 200) : Buffer.from(`line ${seed % 997} of the agent program\n`);
    parts.push(part);
    length += part.length;
  }
  return Buffer.concat(parts).subarray(0, size);
}

for (const [name, data, level] of [
  ["empty data", Buffer.alloc(0), 9],
  ["one byte", Buffer.from("a"), 9],
  ["a long run of one byte", Buffer.alloc(300_000, 0x7a), 1],
  ["random bytes over several blocks", randomBytes(350_000), 1],
  ["mixed text and runs over several blocks", mixed(1_200_000), 2]
]) {
  test(`bunzip2 decodes ${name} as the system bzip2 encodes it`, { skip: noBzip2 }, () => {
    const packed = bzip2(data, level);
    assert.ok(bunzip2(packed, LIMIT).equals(data));
  });
}

test("bunzip2 decodes concatenated streams one after another", { skip: noBzip2 }, () => {
  const first = mixed(150_000);
  const second = randomBytes(20_000);
  assert.ok(bunzip2(Buffer.concat([bzip2(first, 1), bzip2(second, 1)]), LIMIT).equals(Buffer.concat([first, second])));
});

test("bunzip2 refuses data that is not bzip2, ends early, fails its checksum, or passes the limit", { skip: noBzip2 }, () => {
  const data = mixed(200_000);
  const packed = bzip2(data, 1);
  assert.throws(() => bunzip2(Buffer.from("not bzip2 at all"), LIMIT), (error) => error instanceof Bzip2Error && /not bzip2/.test(error.message));
  assert.throws(() => bunzip2(packed.subarray(0, packed.length - 20), LIMIT), Bzip2Error);
  const damaged = Buffer.from(packed);
  damaged[Math.floor(damaged.length / 2)] ^= 0x10;
  assert.throws(() => bunzip2(damaged, LIMIT), Bzip2Error);
  const wrongSum = Buffer.from(packed);
  wrongSum[wrongSum.length - 2] ^= 0x01;
  assert.throws(() => bunzip2(wrongSum, LIMIT), Bzip2Error);
  assert.throws(() => bunzip2(packed, data.length - 1), (error) => error instanceof Bzip2Error && /limit/.test(error.message));
  assert.ok(bunzip2(packed, data.length).equals(data), "exactly the limit decodes");
});

test("bunzip2InWorker decodes in a worker thread and rejects bad data with a Bzip2Error", { skip: noBzip2 }, async () => {
  const data = mixed(300_000);
  assert.ok((await bunzip2InWorker(bzip2(data, 1), LIMIT)).equals(data));
  await assert.rejects(bunzip2InWorker(Buffer.from("not bzip2 at all"), LIMIT), (error) => error instanceof Bzip2Error && /not bzip2/.test(error.message));
});
