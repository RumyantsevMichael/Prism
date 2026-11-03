// P3: what publicRemote and normalizeRemote give for spellings of one remote.
const { publicRemote, normalizeRemote } = await import(new URL("../../../../dist/server/workflow/remote-url.mjs", import.meta.url).href);
for (const url of ["git@github.com:Acme/API.git", "ssh://git@github.com/Acme/API.git", "ssh://git@GitHub.com:22/Acme/API", "https://tok@github.com/Acme/API.git/", "http://github.com/Acme/API", "git://github.com/Acme/API.git", "file:///srv/api.git", "/srv/api", "../api", "https://github.com"]) {
  console.log(JSON.stringify(url), "public:", JSON.stringify(publicRemote(url)), "normalize:", JSON.stringify(normalizeRemote(url)));
}
