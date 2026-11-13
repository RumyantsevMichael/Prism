# One clone per store

## Changes
- change `src/server/workflow/remote-url.mjs`, `dist/server/workflow/remote-url.mjs`: `storeIdentity`, the host and path of an encrypted network store without scheme, user, or port, the same prefixed by its scheme for an `http://` or `git://` store, and `file:` with the real path of a folder store, and `managedStoreId` hashing that identity, with `legacyStoreId` for the folder name that 0.20 derived (§1, §2, §3).
- change `src/server/workflow/record-store-remote.mjs`, `dist/server/workflow/record-store-remote.mjs`: the clone folder named by the identity, the one-time rename of a 0.20 clone whose origin has the same identity, and an adoption check by identity rather than by normalized URL, so a plaintext spelling never reaches an encrypted spelling's clone (§1, §2, §3).
- change `src/server/workflow/machine-checkouts.mjs`, `dist/server/workflow/machine-checkouts.mjs`: checkout entries name the clone folder of the new identity (§2).
- change `docs/user-guide/shared-records.md`: one clone per store whatever its encrypted spelling, a clone of its own for each `http://` or `git://` spelling, and the move of a clone that an earlier version named (§1-§3).
