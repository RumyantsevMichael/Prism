import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(SERVER_DIR);
const PUBLIC_DIR = path.join(SERVER_DIR, "public");
const VENDOR_DIR = path.join(PLUGIN_ROOT, "vendor", "plantuml");
const TEXT_EXTENSIONS = new Set([".md", ".feature", ".puml"]);

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveProjectFile(projectRoot, requestedPath) {
  if (!requestedPath || path.isAbsolute(requestedPath)) {
    throw new Error("The artifact path must be relative to the project root.");
  }
  const candidate = path.resolve(projectRoot, requestedPath);
  if (!isInside(projectRoot, candidate)) {
    throw new Error("The artifact path leaves the project root.");
  }
  const resolved = await realpath(candidate);
  if (!isInside(projectRoot, resolved)) {
    throw new Error("The artifact resolves outside the project root.");
  }
  return resolved;
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function configuredRoots(config) {
  const roots = new Set(["docs"]);
  const pathsSection = config.split(/^## Paths\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  for (const match of pathsSection.matchAll(/^\s*-\s+[^:]+:\s+(.+)\s*$/gm)) {
    const value = match[1].trim().replace(/^['"]|['"]$/g, "");
    if (value === "n/a" || path.isAbsolute(value)) {
      continue;
    }
    const normalized = value.replace(/\/$/, "");
    roots.add(path.extname(normalized) ? path.dirname(normalized) : normalized);
  }
  return [...roots].filter((value) => value && value !== ".");
}

async function walkArtifacts(projectRoot, relativeRoot, results) {
  const absoluteRoot = path.resolve(projectRoot, relativeRoot);
  if (!isInside(projectRoot, absoluteRoot)) {
    return;
  }
  let entries;
  try {
    entries = await readdir(absoluteRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
      continue;
    }
    const relativePath = path.posix.join(relativeRoot.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) {
      await walkArtifacts(projectRoot, relativePath, results);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.add(relativePath);
    }
  }
}

export async function listArtifacts(projectRoot) {
  const config = (await readOptional(path.join(projectRoot, ".prism", "workflow.md"))) ?? "";
  const results = new Set();
  for (const root of configuredRoots(config)) {
    await walkArtifacts(projectRoot, root, results);
  }
  return [...results].sort();
}

function linkedDiagramPaths(artifactPath, content) {
  const directory = path.posix.dirname(artifactPath.split(path.sep).join("/"));
  const links = new Set();
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+\.puml)\)/gi)) {
    const target = decodeURIComponent(match[1].split("#")[0]);
    links.add(path.posix.normalize(path.posix.join(directory, target)));
  }
  if (path.extname(artifactPath).toLowerCase() === ".puml") {
    links.add(artifactPath.split(path.sep).join("/"));
  } else {
    links.add(artifactPath.replace(/\.[^.]+$/, ".puml").split(path.sep).join("/"));
  }
  return [...links];
}

export async function loadArtifact(projectRoot, artifactPath) {
  const absolutePath = await resolveProjectFile(projectRoot, artifactPath);
  const content = await readFile(absolutePath, "utf8");
  const diagrams = [];
  for (const diagramPath of linkedDiagramPaths(artifactPath, content)) {
    try {
      const diagramFile = await resolveProjectFile(projectRoot, diagramPath);
      diagrams.push({ path: diagramPath, source: await readFile(diagramFile, "utf8") });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  const metadata = await stat(absolutePath);
  return { path: artifactPath, content, diagrams, modifiedAt: metadata.mtimeMs };
}

function send(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(body);
}

async function serveFile(response, filePath, contentType) {
  try {
    send(response, 200, await readFile(filePath), contentType);
  } catch (error) {
    if (error.code === "ENOENT") {
      send(response, 404, "Not found");
      return;
    }
    throw error;
  }
}

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function startReviewServer(options = {}) {
  const projectRoot = await realpath(path.resolve(options.projectRoot ?? process.cwd()));
  const token = randomBytes(24).toString("base64url");
  const prefix = `/session/${token}`;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (!url.pathname.startsWith(prefix)) {
        send(response, 404, "Not found");
        return;
      }
      const route = url.pathname.slice(prefix.length) || "/";
      if (route === "/" || route === "/review") {
        await serveFile(response, path.join(PUBLIC_DIR, "review.html"), "text/html; charset=utf-8");
      } else if (route === "/review.js") {
        await serveFile(response, path.join(PUBLIC_DIR, "review.js"), "text/javascript; charset=utf-8");
      } else if (route === "/review.css") {
        await serveFile(response, path.join(PUBLIC_DIR, "review.css"), "text/css; charset=utf-8");
      } else if (route === "/vendor/plantuml.js") {
        await serveFile(response, path.join(VENDOR_DIR, "plantuml.js"), "text/javascript; charset=utf-8");
      } else if (route === "/vendor/viz-global.js") {
        await serveFile(response, path.join(VENDOR_DIR, "viz-global.js"), "text/javascript; charset=utf-8");
      } else if (route === "/c4.min.js" || route === "/vendor/c4.min.js") {
        await serveFile(response, path.join(VENDOR_DIR, "c4.min.js"), "text/javascript; charset=utf-8");
      } else if (route === "/api/index") {
        send(response, 200, JSON.stringify({ projectRoot, artifacts: await listArtifacts(projectRoot) }), "application/json; charset=utf-8");
      } else if (route === "/api/artifact") {
        const artifactPath = url.searchParams.get("path");
        send(response, 200, JSON.stringify(await loadArtifact(projectRoot, artifactPath)), "application/json; charset=utf-8");
      } else {
        send(response, 404, "Not found");
      }
    } catch (error) {
      send(response, 400, error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}${prefix}`;
  return {
    baseUrl,
    projectRoot,
    reviewUrl(artifactPath) {
      return artifactPath ? `${baseUrl}/review?artifact=${encodeURIComponent(artifactPath)}` : `${baseUrl}/`;
    },
    open(artifactPath) {
      const url = this.reviewUrl(artifactPath);
      return { url, opened: openBrowser(url) };
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
