// A bzip2 decoder for unpacking registry agent archives, written against the bzip2 format so the server keeps no dependency for it.
// It decodes one or more concatenated streams, checks every block's and every stream's CRC, and stops once the output would pass `max`.

import { Worker } from "node:worker_threads";

export class Bzip2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Bzip2Error";
  }
}

const fail = (message: string) => new Bzip2Error(message);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i << 24;
    for (let k = 0; k < 8; k += 1) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();

const GROUP_SIZE = 50;
const MAX_GROUPS = 6;
const MAX_CODE_LENGTH = 20;

interface Huffman { min: number; max: number; limit: Int32Array; base: Int32Array; perm: Int32Array }

// The canonical code of one coding table: codes of each length run upward from where the shorter lengths ended.
function huffman(lengths: Uint8Array): Huffman {
  let min = MAX_CODE_LENGTH;
  let max = 0;
  for (const length of lengths) {
    if (length < min) min = length;
    if (length > max) max = length;
  }
  const perm = new Int32Array(lengths.length);
  let next = 0;
  for (let length = min; length <= max; length += 1) {
    for (let symbol = 0; symbol < lengths.length; symbol += 1) if (lengths[symbol] === length) perm[next++] = symbol;
  }
  const limit = new Int32Array(max + 1).fill(-1);
  const base = new Int32Array(max + 1);
  let code = 0;
  let index = 0;
  for (let length = min; length <= max; length += 1) {
    let count = 0;
    for (const value of lengths) if (value === length) count += 1;
    base[length] = index - code;
    code += count;
    index += count;
    limit[length] = code - 1;
    code <<= 1;
  }
  return { min, max, limit, base, perm };
}

/** Decodes bzip2 data, refusing data that is not bzip2, fails a CRC, ends early, or decodes to more than `max` bytes. */
export function bunzip2(input: Buffer, max: number): Buffer {
  // A bit reader for reads of at most 24 bits, holding fewer than 32 unread bits: `held` keeps them in its low `count` bits, and `next` is the next byte to load.
  let next = 0;
  let held = 0;
  let count = 0;
  const bits = (wanted: number) => {
    while (count < wanted) {
      if (next >= input.length) throw fail("The bzip2 data ends early.");
      held = ((held << 8) | input[next++]) >>> 0;
      count += 8;
    }
    count -= wanted;
    const value = (held >>> count) & ((1 << wanted) - 1);
    held &= count === 0 ? 0 : (1 << count) - 1;
    return value >>> 0;
  };
  const bit = () => bits(1);
  const align = () => {
    count -= count % 8;
    held &= count === 0 ? 0 : (1 << count) - 1;
  };
  const exhausted = () => count === 0 && next >= input.length;
  const decode = (table: Huffman) => {
    let length = table.min;
    let value = bits(length);
    while (length <= table.max) {
      if (value <= table.limit[length]) return table.perm[value + table.base[length]];
      value = value * 2 + bit();
      length += 1;
    }
    throw fail("The bzip2 data holds a code that its table does not define.");
  };

  let output = Buffer.allocUnsafeSlow(Math.min(Math.max(input.length * 4, 1 << 16), max + 1));
  let written = 0;
  const reserve = (count: number) => {
    if (written + count > max) throw fail("The bzip2 data decodes to more than the limit.");
    if (written + count <= output.length) return;
    const grown = Buffer.allocUnsafeSlow(Math.min(Math.max(output.length * 2, written + count), max + 1));
    output.copy(grown, 0, 0, written);
    output = grown;
  };

  let streams = 0;
  while (true) {
    align();
    if (streams > 0 && exhausted()) break;
    if (bits(8) !== 0x42 || bits(8) !== 0x5a || bits(8) !== 0x68) throw fail("The data is not bzip2.");
    const level = bits(8) - 0x30;
    if (level < 1 || level > 9) throw fail("The bzip2 data names a block size outside 1 to 9.");
    const blockMax = level * 100_000;
    const tt = new Uint32Array(blockMax);
    let combined = 0;
    while (true) {
      const high = bits(24);
      const low = bits(24);
      if (high === 0x177245 && low === 0x385090) {
        if ((bits(16) * 65536 + bits(16)) !== combined >>> 0) throw fail("The bzip2 stream does not match its checksum.");
        break;
      }
      if (high !== 0x314159 || low !== 0x265359) throw fail("The bzip2 data holds a block of an unknown form.");
      const blockCrc = (bits(16) * 65536 + bits(16));
      if (bit()) throw fail("The bzip2 data uses randomized blocks, which Prism does not unpack.");
      const origin = bits(24);

      const symbols: number[] = [];
      const used = bits(16);
      for (let i = 0; i < 16; i += 1) {
        if (!(used & (0x8000 >>> i))) continue;
        const part = bits(16);
        for (let j = 0; j < 16; j += 1) if (part & (0x8000 >>> j)) symbols.push(i * 16 + j);
      }
      if (!symbols.length) throw fail("The bzip2 block uses no byte values.");
      const alphabet = symbols.length + 2;
      const groups = bits(3);
      if (groups < 2 || groups > MAX_GROUPS) throw fail("The bzip2 block names a number of coding tables outside 2 to 6.");
      const selectorCount = bits(15);
      if (selectorCount < 1) throw fail("The bzip2 block names no coding table selectors.");
      const order = Array.from({ length: groups }, (_, index) => index);
      const selectors = new Uint8Array(selectorCount);
      for (let i = 0; i < selectorCount; i += 1) {
        let j = 0;
        while (bit()) {
          j += 1;
          if (j >= groups) throw fail("The bzip2 block selects a coding table that it does not hold.");
        }
        const chosen = order[j];
        order.splice(j, 1);
        order.unshift(chosen);
        selectors[i] = chosen;
      }
      const tables: Huffman[] = [];
      for (let group = 0; group < groups; group += 1) {
        const lengths = new Uint8Array(alphabet);
        let length = bits(5);
        for (let symbol = 0; symbol < alphabet; symbol += 1) {
          while (true) {
            if (length < 1 || length > MAX_CODE_LENGTH) throw fail("The bzip2 block holds a code length outside 1 to 20.");
            if (!bit()) break;
            length += bit() ? -1 : 1;
          }
          lengths[symbol] = length;
        }
        tables.push(huffman(lengths));
      }

      const endOfBlock = alphabet - 1;
      const counts = new Int32Array(256);
      const front = symbols.slice();
      let size = 0;
      let selector = 0;
      let left = 0;
      let table = tables[0];
      let run = 0;
      let weight = 1;
      while (true) {
        if (left === 0) {
          if (selector >= selectorCount) throw fail("The bzip2 block runs past its coding table selectors.");
          table = tables[selectors[selector++]];
          left = GROUP_SIZE;
        }
        left -= 1;
        const symbol = decode(table);
        if (symbol <= 1) {
          run += (symbol + 1) * weight;
          weight *= 2;
          if (run > blockMax) throw fail("The bzip2 block holds more bytes than its block size.");
          continue;
        }
        if (run) {
          if (size + run > blockMax) throw fail("The bzip2 block holds more bytes than its block size.");
          const value = front[0];
          counts[value] += run;
          tt.fill(value, size, size + run);
          size += run;
          run = 0;
          weight = 1;
        }
        if (symbol === endOfBlock) break;
        const index = symbol - 1;
        if (index >= front.length) throw fail("The bzip2 block moves a byte value that it does not use.");
        const value = front[index];
        front.splice(index, 1);
        front.unshift(value);
        if (size >= blockMax) throw fail("The bzip2 block holds more bytes than its block size.");
        counts[value] += 1;
        tt[size++] = value;
      }
      if (origin >= size) throw fail("The bzip2 block's origin lies outside the block.");

      // Undo the Burrows-Wheeler transform: each entry keeps its byte in the low 8 bits and the next entry's index above them.
      const starts = new Int32Array(256);
      for (let value = 0, sum = 0; value < 256; value += 1) {
        starts[value] = sum;
        sum += counts[value];
      }
      for (let i = 0; i < size; i += 1) {
        const value = tt[i] & 0xff;
        tt[starts[value]++] |= i << 8;
      }

      // Undo the initial run-length step while checking the block's CRC: four equal bytes are followed by a size of more.
      let crc = 0xffffffff;
      let pointer = tt[origin] >>> 8;
      let last = -1;
      let repeats = 0;
      for (let i = 0; i < size; i += 1) {
        const entry = tt[pointer];
        const value = entry & 0xff;
        pointer = entry >>> 8;
        if (repeats === 4) {
          reserve(value);
          output.fill(last, written, written + value);
          written += value;
          for (let k = 0; k < value; k += 1) crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ last) & 0xff];
          repeats = 0;
          continue;
        }
        if (value === last) repeats += 1;
        else {
          repeats = 1;
          last = value;
        }
        reserve(1);
        output[written++] = value;
        crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ value) & 0xff];
      }
      if ((~crc >>> 0) !== blockCrc) throw fail("A bzip2 block does not match its checksum.");
      combined = (((combined << 1) | (combined >>> 31)) ^ blockCrc) >>> 0;
    }
    streams += 1;
  }
  return output.subarray(0, written);
}

/** Decodes bzip2 data like bunzip2, in a worker thread; a decoding failure rejects with a Bzip2Error. */
export function bunzip2InWorker(input: Buffer, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const copy = new Uint8Array(input);
    const worker = new Worker(new URL("./bzip2-worker.mjs", import.meta.url), { workerData: { input: copy, max }, transferList: [copy.buffer] });
    let settled = false;
    worker.once("message", (message: any) => {
      settled = true;
      if (message.error) reject(message.error.name === "Bzip2Error" ? new Bzip2Error(message.error.message) : new Error(message.error.message));
      else resolve(Buffer.from(message.output.buffer, message.output.byteOffset, message.output.byteLength));
      void worker.terminate();
    });
    worker.once("error", (error) => { if (!settled) { settled = true; reject(error); } });
    worker.once("exit", (code) => { if (!settled) { settled = true; reject(new Error(`The bzip2 worker exited with code ${code}.`)); } });
  });
}
