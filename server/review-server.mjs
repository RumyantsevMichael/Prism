import { createServer } from "node:https";
import { randomBytes, X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(SERVER_DIR);
const PUBLIC_DIR = path.join(SERVER_DIR, "public");
const VENDOR_DIR = path.join(PLUGIN_ROOT, "vendor", "plantuml");
const TEXT_EXTENSIONS = new Set([".md", ".feature", ".puml"]);
const AUTHORITY_CERTIFICATE_NAME = "review-ca-cert.pem";
const AUTHORITY_PRIVATE_KEY_NAME = "review-ca-key.pem";
const SERVER_CERTIFICATE_NAME = "review-server-cert.pem";
const SERVER_PRIVATE_KEY_NAME = "review-server-key.pem";
const SERVER_RENEWAL_WINDOW_DAYS = 30;

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

function certificateDirectory(options) {
  if (options.certificateDirectory) {
    return path.resolve(options.certificateDirectory);
  }
  if (process.env.PRISM_REVIEW_CERT_DIR) {
    return path.resolve(process.env.PRISM_REVIEW_CERT_DIR);
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Prism");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? homedir(), "Prism");
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "prism");
}

function runOpenSsl(argumentsValue) {
  return new Promise((resolve, reject) => {
    const child = spawn("openssl", argumentsValue, { stdio: "ignore" });
    child.once("error", (error) => {
      reject(new Error(`Prism could not start openssl: ${error.message}`));
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("Prism could not create its local HTTPS certificate."));
      }
    });
  });
}

async function localCertificate(options) {
  if (options.tls) {
    return { serverOptions: options.tls, authorityCertificatePath: options.certificatePath ?? null, serverCertificatePath: options.certificatePath ?? null };
  }
  const directory = certificateDirectory(options);
  const authorityCertificatePath = path.join(directory, AUTHORITY_CERTIFICATE_NAME);
  const authorityPrivateKeyPath = path.join(directory, AUTHORITY_PRIVATE_KEY_NAME);
  const serverCertificatePath = path.join(directory, SERVER_CERTIFICATE_NAME);
  const serverPrivateKeyPath = path.join(directory, SERVER_PRIVATE_KEY_NAME);
  const configPath = path.join(directory, `review-openssl-${randomBytes(8).toString("hex")}.cnf`);
  const requestPath = path.join(directory, `review-openssl-${randomBytes(8).toString("hex")}.csr`);
  const serialPath = path.join(directory, `review-openssl-${randomBytes(8).toString("hex")}.srl`);
  const config = `[req]\ndistinguished_name = subject\nprompt = no\n[subject]\nCN = Prism Local Development CA\n[authority]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\n[server]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nauthorityKeyIdentifier = keyid,issuer\nsubjectAltName = @names\n[names]\nDNS.1 = localhost\nIP.1 = 127.0.0.1\nIP.2 = ::1\n`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(configPath, config, { mode: 0o600 });
    if (!(await authorityIsUsable(authorityCertificatePath, authorityPrivateKeyPath))) {
      await runOpenSsl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650", "-config", configPath, "-extensions", "authority", "-keyout", authorityPrivateKeyPath, "-out", authorityCertificatePath]);
      await chmod(authorityPrivateKeyPath, 0o600);
    }
    if (!(await serverCertificateIsUsable(serverCertificatePath, serverPrivateKeyPath, authorityCertificatePath))) {
      await runOpenSsl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-config", configPath, "-keyout", serverPrivateKeyPath, "-out", requestPath]);
      await runOpenSsl(["x509", "-req", "-in", requestPath, "-CA", authorityCertificatePath, "-CAkey", authorityPrivateKeyPath, "-CAserial", serialPath, "-CAcreateserial", "-out", serverCertificatePath, "-days", "365", "-sha256", "-extfile", configPath, "-extensions", "server"]);
      await chmod(serverPrivateKeyPath, 0o600);
    }
  } finally {
    await Promise.all([rm(configPath, { force: true }), rm(requestPath, { force: true }), rm(serialPath, { force: true })]);
  }
  return {
    serverOptions: { cert: await readFile(serverCertificatePath), key: await readFile(serverPrivateKeyPath) },
    authorityCertificatePath,
    serverCertificatePath
  };
}

async function certificateIsUsable(certificatePath, privateKeyPath, renewalWindowDays) {
  try {
    const [certificate, privateKey] = await Promise.all([readFile(certificatePath), readFile(privateKeyPath)]);
    const expiry = Date.parse(new X509Certificate(certificate).validTo);
    return privateKey.length > 0 && Number.isFinite(expiry) && expiry > Date.now() + renewalWindowDays * 24 * 60 * 60 * 1000;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function authorityIsUsable(certificatePath, privateKeyPath) {
  return certificateIsUsable(certificatePath, privateKeyPath, 0);
}

async function serverCertificateIsUsable(certificatePath, privateKeyPath, authorityCertificatePath) {
  if (!(await certificateIsUsable(certificatePath, privateKeyPath, SERVER_RENEWAL_WINDOW_DAYS))) {
    return false;
  }
  try {
    const [serverCertificate, authorityCertificate] = await Promise.all([readFile(certificatePath), readFile(authorityCertificatePath)]);
    const server = new X509Certificate(serverCertificate);
    const authority = new X509Certificate(authorityCertificate);
    return server.checkIssued(authority) && server.verify(authority.publicKey);
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function certificateTrustInstructions(authorityCertificatePath) {
  if (!authorityCertificatePath) {
    return null;
  }
  if (process.platform === "darwin") {
    const quotedPath = `'${authorityCertificatePath.replaceAll("'", "'\\''")}'`;
    return `Trust the Prism local development authority once: security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ${quotedPath}`;
  }
  if (process.platform === "win32") {
    return `Trust the Prism local development authority once: import ${authorityCertificatePath} into the Current User Trusted Root Certification Authorities store.`;
  }
  return `Trust the Prism local development authority once: import ${authorityCertificatePath} into your browser certificate store.`;
}

function normalizeTabs(value) {
  if (value === undefined) {
    return [];
  }
  const tabs = typeof value === "string" ? [value] : value;
  if (!Array.isArray(tabs) || tabs.some((tab) => typeof tab !== "string" || !tab)) {
    throw new Error("The open tabs must be an array of project-relative artifact paths.");
  }
  return [...new Set(tabs)];
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      throw new Error("The request body is too large.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("The request body must be JSON.");
  }
}

export async function startReviewServer(options = {}) {
  const browserOpener = options.openBrowser ?? openBrowser;
  const projectRoot = await realpath(path.resolve(options.projectRoot ?? process.cwd()));
  const certificate = await localCertificate(options);
  const token = randomBytes(24).toString("base64url");
  const prefix = `/session/${token}`;
  let openTabs = [];
  async function setOpenTabs(tabs) {
    const requestedTabs = normalizeTabs(tabs);
    const availableArtifacts = new Set(await listArtifacts(projectRoot));
    const unknownTab = requestedTabs.find((tab) => !availableArtifacts.has(tab));
    if (unknownTab) {
      throw new Error(`The artifact is not available for review: ${unknownTab}`);
    }
    openTabs = requestedTabs;
    return openTabs;
  }
  const server = createServer(certificate.serverOptions, async (request, response) => {
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
        send(response, 200, JSON.stringify({ projectRoot, artifacts: await listArtifacts(projectRoot), openTabs }), "application/json; charset=utf-8");
      } else if (route === "/api/session" && request.method === "GET") {
        send(response, 200, JSON.stringify({ openTabs }), "application/json; charset=utf-8");
      } else if (route === "/api/session" && request.method === "PUT") {
        const body = await readJson(request);
        send(response, 200, JSON.stringify({ openTabs: await setOpenTabs(body.openTabs) }), "application/json; charset=utf-8");
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
  const baseUrl = `https://127.0.0.1:${address.port}${prefix}`;
  return {
    baseUrl,
    projectRoot,
    certificatePath: certificate.authorityCertificatePath,
    serverCertificatePath: certificate.serverCertificatePath,
    trustInstructions: certificateTrustInstructions(certificate.authorityCertificatePath),
    getOpenTabs() {
      return [...openTabs];
    },
    async setOpenTabs(tabs) {
      return setOpenTabs(tabs);
    },
    reviewUrl(artifactPaths) {
      const [activeTab] = normalizeTabs(artifactPaths);
      return activeTab ? `${baseUrl}/review?artifact=${encodeURIComponent(activeTab)}` : `${baseUrl}/`;
    },
    async open(artifactPaths) {
      const tabs = normalizeTabs(artifactPaths);
      await setOpenTabs(tabs);
      const url = this.reviewUrl(tabs);
      return { url, opened: browserOpener(url) };
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
