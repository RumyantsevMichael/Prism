import { lstat, mkdir, readFile, realpath, symlink, writeFile, chmod, copyFile } from "node:fs/promises";
import path from "node:path";
import { crc32, gunzipSync, inflateRawSync } from "node:zlib";

// Unpacking a registry agent's archive into its version folder with Node's own zlib, running nothing from it.
// Every entry is read and checked before the first one is written: an absolute path, a `..` part, a link that leads outside the folder,
// or an entry of any kind other than a file, a folder, or a link refuses the whole archive, and nothing lands outside the folder.

export const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024 - 1;
const MAX_ENTRIES = 200_000;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

interface Entry { name: string; kind: "file" | "directory" | "symlink" | "hardlink"; mode: number; data?: Buffer; target?: string }

const refuse = (message: string) => new ArchiveError(message);

// The parts of an entry name inside the folder, or a refusal: no absolute path, drive, or `..` part, and no empty name.
function entryParts(name: string): string[] {
  if (name.includes("\0")) throw refuse(`The archive entry ${JSON.stringify(name)} holds a NUL character.`);
  if (/^[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) throw refuse(`The archive entry ${JSON.stringify(name)} has an absolute path.`);
  const parts = name.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw refuse(`The archive entry ${JSON.stringify(name)} leads outside the version folder with a .. part.`);
  return parts;
}

const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// Checks every entry, then writes them in order, refusing a write through a link and any link whose target leaves the folder.
async function writeEntries(entries: Entry[], folder: string) {
  if (entries.length > MAX_ENTRIES) throw refuse(`The archive holds more than ${MAX_ENTRIES} entries.`);
  const root = path.resolve(folder);
  const planned = entries.map((entry) => {
    const parts = entryParts(entry.name);
    const file = path.join(root, ...parts);
    if (parts.length === 0) {
      if (entry.kind === "directory") return null;
      throw refuse(`The archive entry ${JSON.stringify(entry.name)} names no file.`);
    }
    if (entry.kind === "symlink") {
      const target = entry.target ?? "";
      if (path.isAbsolute(target) || /^[\\/]/.test(target) || /^[A-Za-z]:/.test(target)) throw refuse(`The archive link ${JSON.stringify(entry.name)} points at the absolute path ${JSON.stringify(target)}.`);
      if (!inside(root, path.resolve(path.dirname(file), target))) throw refuse(`The archive link ${JSON.stringify(entry.name)} leads outside the version folder.`);
    }
    if (entry.kind === "hardlink") {
      const source = path.join(root, ...entryParts(entry.target ?? ""));
      if (!inside(root, source) || source === root) throw refuse(`The archive link ${JSON.stringify(entry.name)} leads outside the version folder.`);
      return { entry, file, source };
    }
    return { entry, file, source: null };
  }).filter((item) => item !== null);
  await mkdir(root, { recursive: true });
  const links: string[] = [];
  for (const { entry, file, source } of planned) {
    // Every folder above the entry must be a real folder inside the version folder, never a link that the archive made.
    let parent = root;
    for (const part of path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)) {
      parent = path.join(parent, part);
      const info = await lstat(parent).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
      if (info === null) await mkdir(parent, { mode: 0o755 });
      else if (!info.isDirectory()) throw refuse(`The archive entry ${JSON.stringify(entry.name)} would be written through ${JSON.stringify(path.relative(root, parent))}, which is not a folder.`);
    }
    const existing = await lstat(file).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
    if (entry.kind === "directory") {
      if (existing === null) await mkdir(file, { mode: 0o755 });
      else if (!existing.isDirectory()) throw refuse(`The archive entry ${JSON.stringify(entry.name)} is a folder and also another kind of entry.`);
      continue;
    }
    if (existing !== null) throw refuse(`The archive holds the entry ${JSON.stringify(entry.name)} more than once.`);
    if (entry.kind === "symlink") {
      await symlink(entry.target!, file);
      links.push(file);
    } else if (entry.kind === "hardlink") {
      const info = await lstat(source!).catch(() => null);
      if (!info?.isFile()) throw refuse(`The archive link ${JSON.stringify(entry.name)} names no file of the archive before it.`);
      await copyFile(source!, file);
    } else {
      await writeFile(file, entry.data ?? Buffer.alloc(0), { flag: "wx", mode: 0o600 });
      // Only the permission bits are kept, never set-id or sticky bits, and owner read and write always.
      await chmod(file, (entry.mode & 0o777) | 0o600);
    }
  }
  // A link may lead through another link, so each one that resolves is checked again where it really leads.
  const real = await realpath(root);
  for (const file of links) {
    const resolved = await realpath(file).catch(() => null);
    if (resolved !== null && !inside(real, resolved)) throw refuse(`The archive link ${JSON.stringify(path.relative(root, file))} leads outside the version folder.`);
  }
}

// ---- tar.gz ----

const tarText = (block: Buffer, start: number, length: number) => {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
};

function tarNumber(block: Buffer, start: number, length: number) {
  const field = block.subarray(start, start + length);
  // A base-256 number sets the high bit of its first byte.
  if (field[0] & 0x80) {
    let value = field[0] & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = tarText(block, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw refuse("The archive has a malformed tar header.");
  return parseInt(text, 8);
}

function paxRecords(data: Buffer) {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(data.subarray(offset, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) throw refuse("The archive has a malformed pax header.");
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/** The entries of a tar stream. */
export function tarEntries(tar: Buffer): Entry[] {
  const entries: Entry[] = [];
  let offset = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  let globalPax: Record<string, string> = {};
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
    if (sum !== tarNumber(header, 148, 8)) throw refuse("The archive has a tar header whose checksum does not match.");
    const type = String.fromCharCode(header[156] || 0x30);
    const size = tarNumber(header, 124, 12);
    const dataStart = offset + 512;
    if (dataStart + size > tar.length) throw refuse("The archive ends inside an entry.");
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") { pax = paxRecords(data); continue; }
    if (type === "g") { globalPax = { ...globalPax, ...paxRecords(data) }; continue; }
    if (type === "L") { longName = tarText(data, 0, data.length); continue; }
    if (type === "K") { longLink = tarText(data, 0, data.length); continue; }
    const magic = tarText(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? tarText(header, 345, 155) : "";
    const headerName = prefix ? `${prefix}/${tarText(header, 0, 100)}` : tarText(header, 0, 100);
    const fields = { ...globalPax, ...pax };
    const name = fields.path ?? longName ?? headerName;
    const target = fields.linkpath ?? longLink ?? tarText(header, 157, 100);
    const mode = tarNumber(header, 100, 8);
    longName = null;
    longLink = null;
    pax = {};
    if (type === "0" || type === "7") entries.push({ name, kind: "file", mode, data: Buffer.from(data) });
    else if (type === "5") entries.push({ name, kind: "directory", mode });
    else if (type === "2") entries.push({ name, kind: "symlink", mode, target });
    else if (type === "1") entries.push({ name, kind: "hardlink", mode, target });
    else throw refuse(`The archive entry ${JSON.stringify(name)} is a kind of file that Prism does not unpack.`);
  }
  return entries;
}

/** Unpacks a .tar.gz or .tgz file into folder, refusing any entry that would land outside it. */
export async function extractTarGz(file: string, folder: string) {
  let tar: Buffer;
  try {
    tar = gunzipSync(await readFile(file), { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (error: any) {
    throw refuse(error?.code === "ERR_BUFFER_TOO_LARGE" ? "The archive unpacks to more than 2 GiB." : "The archive is not a valid gzip file.");
  }
  await writeEntries(tarEntries(tar), folder);
}

// ---- zip ----

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/** The entries of a zip file, read from its central directory. */
export function zipEntries(zip: Buffer): Entry[] {
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end === -1) throw refuse("The archive is not a valid zip file.");
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw refuse("The archive is a zip64 file, which Prism does not unpack.");
  const entries: Entry[] = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) throw refuse("The archive has a malformed zip directory.");
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const sum = zip.readUInt32LE(offset + 16);
    const packedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const madeBy = zip.readUInt16LE(offset + 4) >> 8;
    const external = zip.readUInt32LE(offset + 38);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
    offset += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) throw refuse(`The archive entry ${JSON.stringify(name)} is encrypted.`);
    if (packedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw refuse("The archive is a zip64 file, which Prism does not unpack.");
    // Unix modes live in the high half of the external attributes when the entry was made on Unix.
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    const type = unixMode & S_IFMT;
    const directory = name.endsWith("/") || type === S_IFDIR;
    if (directory) { entries.push({ name, kind: "directory", mode: 0o755 }); continue; }
    if (type !== 0 && type !== S_IFREG && type !== S_IFLNK) throw refuse(`The archive entry ${JSON.stringify(name)} is a kind of file that Prism does not unpack.`);
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw refuse("The archive has a malformed zip entry.");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + packedSize > zip.length) throw refuse("The archive ends inside an entry.");
    total += size;
    if (total > MAX_UNPACKED_BYTES) throw refuse("The archive unpacks to more than 2 GiB.");
    const packed = zip.subarray(start, start + packedSize);
    let data: Buffer;
    try {
      if (method === 0) data = Buffer.from(packed);
      else if (method === 8) data = inflateRawSync(packed, { maxOutputLength: Math.max(size, 1) });
      else throw refuse(`The archive entry ${JSON.stringify(name)} uses a compression method that Prism does not unpack.`);
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      throw refuse(`The archive entry ${JSON.stringify(name)} cannot be unpacked.`);
    }
    if (data.length !== size || crc32(data) !== sum) throw refuse(`The archive entry ${JSON.stringify(name)} does not match its checksum.`);
    if (type === S_IFLNK) entries.push({ name, kind: "symlink", mode: 0o777, target: data.toString("utf8") });
    else entries.push({ name, kind: "file", mode: unixMode & 0o777 || 0o644, data });
  }
  return entries;
}

/** Unpacks a .zip file into folder, refusing any entry that would land outside it. */
export async function extractZip(file: string, folder: string) {
  await writeEntries(zipEntries(await readFile(file)), folder);
}
