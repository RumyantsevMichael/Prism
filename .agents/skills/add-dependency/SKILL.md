---
name: add-dependency
description: Check a dependency's license, and the licenses of everything it pulls in, against Prism's dependency policy before adding or upgrading it. Use before installing, adding, upgrading, vendoring, or copying any package, library, model, font, or code snippet into this repository.
---

# Add a dependency

Prism is licensed under Apache 2.0, and its code must stay combinable with closed-source code.
A dependency with a conflicting license can force code that uses Prism to be published, or forbid commercial use, and removing it later means rewriting what depends on it.
So check the license before the dependency enters the repository, not after.

The policy is [Dependencies in CONTRIBUTING.md](../../../CONTRIBUTING.md#dependencies).
Read it before you start.

## Procedure

1. Decide whether the dependency ships.
   It ships if it reaches users: a runtime dependency of `src/` or `dist/`, anything under `vendor/`, anything in a native runtime archive, a model, a font, or copied code.
   It does not ship if only development uses it: tests, build scripts, linters, CI.
2. Find the license of the package and of every package it pulls in.
   Install with scripts disabled (`npm install --ignore-scripts`), then list the licenses from the lockfile it changed:

   ```bash
   node -e 'const l=require(process.argv[1]);for(const[p,m]of Object.entries(l.packages))if(p)console.log(m.license??"UNKNOWN",p)' "$PWD/src/native-runtime/package-lock.json" | sort | uniq -c
   ```

   For a model, font, or copied file, read the license on its source page or in its repository.
3. Classify each license with the policy table.
   Treat a missing, unknown, or custom license as not allowed until the maintainer approves it.
   Optional platform packages count: a package marked `optional` still ships on the platform it serves.
4. Stop and ask the maintainer before adding anything that the policy does not allow without approval.
   Name the package, the license, whether it ships, which package pulls it in, and an alternative if you found one.
   Do not add it while waiting.
5. For a shipped dependency, record its license text and copyright notice where Prism already keeps them: `THIRD_PARTY_NOTICES.md` and `vendor/<component>/LICENSE` for vendored files, or the license files the native runtime build collects.
6. Run `npm run check:licenses`, which CI also runs, and resolve every reported package.
7. Say in the commit body which new licenses the change brings in, or that it brings in none.
