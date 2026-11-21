import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, lchown, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {assertSafeAncestors} from '../../dist/server/repository-intelligence/native-files.mjs';

// The operating system's own links, such as /var and /tmp on macOS or /bin on a Linux with a merged /usr, are owned by root and sit in
// folders that only root can write, so private storage under them is trusted. Any other link on the way is refused.
const posix = process.platform !== 'win32';
const asRoot = posix && process.getuid() === 0;
const systemFolder = info => info.isDirectory() && info.uid === 0 && (info.mode & 0o022) === 0;
const refused = {code: 'invalid_path'};

async function systemLink() {
  if (!posix || !systemFolder(await lstat('/'))) return null;
  for (const name of await readdir('/')) {
    const link = path.join('/', name), info = await lstat(link);
    if (!info.isSymbolicLink() || info.uid !== 0) continue;
    const target = await realpath(link).catch(() => null);
    if (target && (await lstat(target)).isDirectory()) return link;
  }
  return null;
}
const osLink = await systemLink();

test('trusts a link the operating system owns, such as /var on macOS', {skip: osLink ? false : 'no root-owned link to a folder at the filesystem root'}, async () => {
  await assertSafeAncestors(osLink, 501);
  if (!asRoot) await assertSafeAncestors(osLink);
});

test('refuses an operating-system link when the process itself is root, since every link root makes is root-owned', {skip: osLink ? false : 'no root-owned link to a folder at the filesystem root'}, async () => {
  await assert.rejects(assertSafeAncestors(osLink, 0), refused);
});

test('refuses a link the user made in a temporary folder', async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'prism-links-')));
  try {
    await mkdir(path.join(home, 'target'));
    const link = path.join(home, 'alias');
    await symlink(path.join(home, 'target'), link);
    await assert.rejects(assertSafeAncestors(link), refused);
    if (posix) await assert.rejects(assertSafeAncestors(link, 501), refused);
  } finally { await rm(home, {recursive: true, force: true}); }
});

// Only root can make a root-owned link in folders that only root can write, so these run in a root container, judging as an ordinary user.
test('trusts a root-owned link only while no one but root can change it', {skip: asRoot ? false : 'needs root to own the link'}, async t => {
  const base = await mkdtemp(path.join(os.homedir(), '.prism-links-'));
  try {
    const chain = [];
    for (let folder = base; ; folder = path.dirname(folder)) { chain.push(folder); if (path.dirname(folder) === folder) break; }
    if (!(await Promise.all(chain.map(async folder => systemFolder(await lstat(folder))))).every(Boolean)) return t.skip('the home folder is writable by others');
    await mkdir(path.join(base, 'target', 'store'), {recursive: true});
    const link = path.join(base, 'alias'), store = path.join(link, 'store');
    await symlink(path.join(base, 'target'), link);
    await assertSafeAncestors(store, 501);

    await lchown(link, 501, 501);
    await assert.rejects(assertSafeAncestors(store, 501), refused, 'a link another user owns');
    await lchown(link, 0, 0);

    await chmod(base, 0o777);
    await assert.rejects(assertSafeAncestors(store, 501), refused, 'a link in a folder others can write');
    await chmod(base, 0o700);

    await symlink(path.join(base, 'target', 'store'), path.join(base, 'target', 'inner'));
    await chmod(path.join(base, 'target'), 0o777);
    await assert.rejects(assertSafeAncestors(path.join(link, 'inner'), 501), refused, 'a link inside the trusted target that others could replace');
  } finally { await rm(base, {recursive: true, force: true}); }
});
