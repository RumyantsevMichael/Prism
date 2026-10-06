import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { realpath, lstat, readlink } from "node:fs/promises";
import { NativeRepositoryIntelligence, openNativeRepositoryIntelligence } from "../repository-intelligence/native-repository-intelligence.mjs";
import { privateDirectory, regularBytes, semanticError } from "../repository-intelligence/native-semantic-runtime.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { resolveArtifactPath } from "./concept-delta.mjs";
import type { Evidence, SnapshotEvidence, InventoryEntry } from "./conservation-types.mjs";
import type { NativeSource, SourceSnapshot, SourceFile, Diagnostic } from "../repository-intelligence/repository-concept-types.mjs";

export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const conservationError = (code: string, message: string, details: Record<string, unknown> = {}) => Object.assign(semanticError(code, message), details);
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, "en"))) : item);
export const withinScope = (file: string, scope: string[]) => scope.some(prefix => file === prefix || file.startsWith(`${prefix}/`));
const validId = (id: string) => { if (!/^[a-f\d]{64}$/.test(id)) throw conservationError("validation_failed", "Evidence IDs must be SHA-256 values."); return id; };
interface InventorySnapshot extends SourceSnapshot { inventory: (InventoryEntry & { absolutePath?: string })[]; omissions: SnapshotEvidence["omissions"]; unknownOmissions: boolean; diagnostics: Diagnostic[] }
interface Registry { schemaVersion: 1; outputs: string[] }

async function retainImmutable(target: string, bytes: string | Uint8Array, expectedHash: string, corruptMessage: string) {
  await withArtifactLock(target, () => withFileLock(target, async () => {
    try { if (digest(await regularBytes(target)) !== expectedHash) throw conservationError("evidence_missing", corruptMessage); }
    catch (error) { if (error.code !== "ENOENT") throw error; await writeAtomically(target, bytes, { mode: 0o600 }); }
  }));
}

export class ConservationStore {
  directory: string;
  constructor(directory?: string) {
    const hostData = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
    this.directory = path.resolve(directory || (hostData ? path.join(hostData, "conservation") : path.join(os.homedir(), ".local", "share", "prism", "conservation")));
  }
  async location(projectRoot: string, create = false) {
    if (!path.isAbsolute(projectRoot)) throw conservationError("invalid_path", "The project root must be absolute.");
    const root = await realpath(projectRoot), relative = path.relative(root, this.directory);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw conservationError("invalid_path", "Evidence storage must be outside the project.");
    const directory = path.join(this.directory, digest(root));
    if (create) await privateDirectory(directory);
    return { root, directory };
  }
  async outputs(projectRoot: string): Promise<string[]> {
    const { directory } = await this.location(projectRoot);
    try {
      const record = JSON.parse((await regularBytes(path.join(directory, "outputs.json"), 1024 * 1024)).toString()) as Registry;
      if (record.schemaVersion !== 1 || !Array.isArray(record.outputs) || record.outputs.some(file => typeof file !== "string")) throw new Error();
      return record.outputs;
    } catch (error) { if (error.code === "ENOENT") return []; throw conservationError("evidence_missing", "The managed output registry is invalid."); }
  }
  async registerSlice(projectRoot: string, deltaPath: string, legacyRevision?: string) {
    const resolved = await resolveArtifactPath(projectRoot, deltaPath);
    const { directory } = await this.location(projectRoot, true), registry = path.join(directory, "outputs.json");
    const parent = path.posix.dirname(resolved.deltaPath);
    const artifacts = [resolved.deltaPath, `${parent}/review.json`, `${parent}/review.md`];
    const outputs = [...artifacts, ...artifacts.map(file => `${file}.lock`)];
    const owned = await this.outputs(projectRoot);
    for (const output of outputs.filter(output => !owned.includes(output))) {
      try { await lstat(path.join(resolved.root, output)); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (output === resolved.deltaPath && legacyRevision) {
        const bytes = await regularBytes(path.join(resolved.root, output), 1024 * 1024);
        if (digest(bytes) !== legacyRevision || JSON.parse(bytes.toString()).schemaVersion !== 1) throw conservationError("revision_conflict", "The legacy delta changed before migration.");
        await this.put(projectRoot, { kind: "migration", schemaVersion: 1, project: resolved.root, artifactPath: output, revision: legacyRevision, lines: bytes.toString().split("\n") });
        continue;
      }
      throw conservationError("invalid_path", "Register evidence outputs before creating them; an existing source file cannot be claimed by filename.", { file: output });
    }
    for (const output of outputs) if (!(owned.includes(output) && output.endsWith("/review.md"))) await resolveArtifactPath(projectRoot, output, false, path.posix.basename(output));
    await withArtifactLock(registry, () => withFileLock(registry, async () => {
      const current = await this.outputs(projectRoot), next = [...new Set([...current, ...outputs])].sort();
      if (canonical(current) !== canonical(next)) await writeAtomically(registry, canonical({ schemaVersion: 1, outputs: next }), { mode: 0o600 });
    }));
    return outputs;
  }
  async registerCoordinationOutputs(projectRoot: string, outputs: string[]) {
    const { directory, root } = await this.location(projectRoot, true), registry = path.join(directory, "outputs.json");
    for (const output of outputs) {
      const name = path.posix.basename(output);
      if (!["state.json", "recovery.md"].includes(name)) throw conservationError("invalid_path", "Only coordination evidence can be registered here.");
      await resolveArtifactPath(root, output, false, name);
    }
    await withArtifactLock(registry, () => withFileLock(registry, async () => {
      const current = await this.outputs(root), additions: string[] = [];
      for (const output of outputs.filter(output => !current.includes(output))) {
        // Existing legacy files remain source evidence until explicit migration; never hide them.
        try { await lstat(path.join(root, output)); }
        catch (error) { if (error.code !== "ENOENT") throw error; additions.push(output); }
      }
      if (additions.length) await writeAtomically(registry, canonical({ schemaVersion: 1, outputs: [...new Set([...current, ...additions, ...additions.map(file => `${file}.lock`)])].sort() }), { mode: 0o600 });
    }));
  }
  async writeManaged(projectRoot: string, target: string, contents: string) {
    const { root, directory } = await this.location(projectRoot, true), registry = path.join(directory, "outputs.json");
    const artifact = path.relative(root, target).split(path.sep).join("/");
    if (!(await this.outputs(root)).includes(artifact)) return writeAtomically(target, contents);
    const changeTemporary = async (temporary: string, add: boolean) => {
      const relative = path.relative(root, temporary).split(path.sep).join("/");
      await withArtifactLock(registry, () => withFileLock(registry, async () => {
        const current = await this.outputs(root), next = add ? [...new Set([...current, relative])].sort() : current.filter(file => file !== relative);
        await writeAtomically(registry, canonical({ schemaVersion: 1, outputs: next }), { mode: 0o600 });
      }));
    };
    await writeAtomically(target, contents, { beforeTemporary: file => changeTemporary(file, true), afterTemporary: file => changeTemporary(file, false) });
  }
  async put(projectRoot: string, evidence: Evidence): Promise<string> {
    const { root, directory } = await this.location(projectRoot, true);
    if (evidence.project !== root) throw conservationError("invalid_path", "Evidence belongs to a different project.");
    const bytes = canonical(evidence), id = digest(bytes);
    if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) throw conservationError("resource_limit", "The evidence record exceeds 64 MiB.");
    const records = await privateDirectory(path.join(directory, "records")), target = path.join(records, `${id}.json`);
    await retainImmutable(target, bytes, id, "Existing immutable evidence is corrupt.");
    return id;
  }
  async link(projectRoot: string, snapshotId: string, evidenceId: string) {
    const { directory } = await this.location(projectRoot, true);
    const links = await privateDirectory(path.join(directory, "analyses"));
    const target = path.join(links, `${validId(snapshotId)}.json`);
    await withArtifactLock(target, () => withFileLock(target, () => writeAtomically(target, canonical({ evidenceId: validId(evidenceId) }), { mode: 0o600 })));
  }
  async analysis(projectRoot: string, snapshotId: string) {
    const { directory } = await this.location(projectRoot);
    try {
      const pointer = JSON.parse((await regularBytes(path.join(directory, "analyses", `${validId(snapshotId)}.json`), 4096)).toString());
      const record = await this.get<Extract<Evidence, { kind: "analysis" }>>(projectRoot, pointer.evidenceId, "analysis");
      if (record.snapshotId !== snapshotId) throw conservationError("evidence_missing", "The retained analysis belongs to another snapshot.");
      return record;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async get<T extends Evidence = Evidence>(projectRoot: string, id: string, kind?: T["kind"]): Promise<T> {
    const { root, directory } = await this.location(projectRoot);
    try {
      const bytes = await regularBytes(path.join(directory, "records", `${validId(id)}.json`), 64 * 1024 * 1024);
      if (digest(bytes) !== id) throw new Error();
      const record = JSON.parse(bytes.toString()) as T;
      if (record.schemaVersion !== 1 || record.project !== root || (kind && record.kind !== kind)) throw new Error();
      return record;
    } catch (error) {
      if (["validation_failed", "invalid_path"].includes(error.code)) throw error;
      throw conservationError("evidence_missing", "Required immutable evidence is missing or corrupt.", { evidenceId: id });
    }
  }
  async blobPath(projectRoot: string, hash: string) {
    const { directory } = await this.location(projectRoot);
    return path.join(directory, "blobs", validId(hash));
  }
  async bytes(projectRoot: string, entry: InventoryEntry) {
    try {
      const bytes = await regularBytes(await this.blobPath(projectRoot, entry.hash), 2 * 1024 * 1024);
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.hash) throw new Error();
      return bytes;
    } catch { throw conservationError("evidence_missing", "Retained source bytes are missing or corrupt.", { file: entry.file }); }
  }
  async capture(projectRoot: string, deltaPath?: string) {
    if (deltaPath) await this.registerSlice(projectRoot, deltaPath);
    const { root, directory } = await this.location(projectRoot, true);
    const source = await openNativeRepositoryIntelligence(root, { retainOpaque: true });
    const snapshot = await source.snapshot() as unknown as InventorySnapshot, exclusions = await this.outputs(root);
    const selected = snapshot.inventory.filter(entry => !exclusions.includes(entry.file));
    const blobs = await privateDirectory(path.join(directory, "blobs"));
    for (const entry of selected) {
      const bytes = entry.kind === "symlink" ? await readlink(path.join(root, entry.file), { encoding: "buffer" }) : await regularBytes(entry.absolutePath!, 2 * 1024 * 1024);
      if (digest(bytes) !== entry.hash) throw conservationError("stale_snapshot", "Source changed during baseline capture.", { file: entry.file });
      const target = path.join(blobs, entry.hash);
      await retainImmutable(target, bytes, entry.hash, "A retained source blob is corrupt.");
    }
    try { await source.verifySnapshot(); }
    catch { throw conservationError("stale_snapshot", "Source changed during baseline capture."); }
    const files = selected.map(({ file, kind, hash, bytes, mode, target }) => ({ file, kind, hash, bytes, mode, ...(target === undefined ? {} : { target }) }));
    const evidence: SnapshotEvidence = { kind: "snapshot", schemaVersion: 1, project: root, commit: snapshot.commit,
      capturePolicy: "conservation-source-v1", fingerprint: digest(canonical(files)), files, exclusions,
      omissions: snapshot.omissions.filter(item => !exclusions.includes(item.file)), complete: snapshot.complete, unknownOmissions: snapshot.unknownOmissions, diagnostics: snapshot.diagnostics };
    return { snapshotId: await this.put(root, evidence), snapshot: evidence };
  }
  async source(projectRoot: string, snapshotId: string): Promise<NativeSource> {
    const snapshot = await this.get<SnapshotEvidence>(projectRoot, snapshotId, "snapshot"), files: SourceFile[] = [];
    for (const entry of snapshot.files) if (entry.kind === "source") {
      const content = (await this.bytes(projectRoot, entry)).toString("utf8");
      files.push(Object.assign({ file: entry.file, hash: entry.hash,
        absolutePath: await this.blobPath(projectRoot, entry.hash), content },
        { lineCount: (content.match(/[^\n]*\n|[^\n]+$/g) || [""]).length, bytes: entry.bytes, kind: "source" }));
    }
    const retained = new NativeRepositoryIntelligence(snapshot.project) as unknown as NativeSource;
    const value: SourceSnapshot = { root: snapshot.project, commit: snapshot.commit, sourceFingerprint: snapshot.fingerprint,
      complete: snapshot.complete, files, filesByPath: new Map(files.map(file => [file.file, file])) };
    Object.assign(value, { diagnostics: snapshot.diagnostics, enumerator: "retained", totalBytes: snapshot.files.reduce((sum, file) => sum + file.bytes, 0) });
    retained.snapshot = async () => value;
    retained.verifySnapshot = async () => {
      await this.get(projectRoot, snapshotId, "snapshot");
      for (const entry of snapshot.files) await this.bytes(projectRoot, entry);
    };
    // The native read method checks live paths; retained reads use only verified blobs.
    retained.read = async input => {
      const source = value.filesByPath.get(input.file);
      if (!source) throw conservationError("evidence_missing", "The retained source range is unavailable.");
      const lines = source.content.match(/[^\n]*\n|[^\n]+$/g) || [""];
      const { startLine, endLine } = input.range;
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) throw conservationError("validation_failed", "The retained source range is invalid.");
      const content = lines.slice(startLine - 1, endLine).join("");
      return { content, rendered: content, range: input.range, rangeComplete: true };
    };
    retained.validateSourceRange = async input => { await retained.read(input); return input; };
    return retained;
  }
  async assertCurrent(projectRoot: string, snapshotId: string) {
    const before = await this.get<SnapshotEvidence>(projectRoot, snapshotId, "snapshot");
    for (const file of before.files) await this.bytes(projectRoot, file);
    const current = await this.capture(projectRoot), exclusions = await this.outputs(projectRoot);
    const allowed = exclusions.filter(file => !before.files.some(entry => entry.file === file));
    const selected = (record: SnapshotEvidence) => canonical({ files: record.files.filter(file => !allowed.includes(file.file)), omissions: record.omissions, complete: record.complete });
    if (selected(before) !== selected(current.snapshot)) throw conservationError("stale_snapshot", "The source changed after the accepted evidence.", { expectedSnapshot: snapshotId, currentSnapshot: current.snapshotId });
    return current.snapshotId;
  }
}

export const conservationStore = new ConservationStore();
