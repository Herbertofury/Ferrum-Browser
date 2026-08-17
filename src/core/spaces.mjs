import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_SPACES_ROOT = path.join(os.homedir(), '.ferrum', 'spaces');

export function normalizeSpaceName(name) {
  const value = String(name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error('Space name must be 1-64 characters using letters, numbers, dot, underscore, or hyphen');
  }
  return value;
}

function rootPath(root) {
  return path.resolve(root || DEFAULT_SPACES_ROOT);
}

function pathsFor(name, root) {
  const safe = normalizeSpaceName(name);
  const rootDir = rootPath(root);
  const dir = path.join(rootDir, safe);
  return { rootDir, name: safe, dir, profileDir: path.join(dir, 'profile'), manifestPath: path.join(dir, 'space.json'), lockPath: path.join(dir, '.lock') };
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function writeManifest(paths, data) {
  await fs.writeFile(paths.manifestPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function readManifest(paths) {
  try { return JSON.parse(await fs.readFile(paths.manifestPath, 'utf8')); }
  catch { return { schemaVersion: 1, name: paths.name, createdAt: null, clonedFrom: null }; }
}

export async function createSpace(name, { root, cloneFrom } = {}) {
  const target = pathsFor(name, root);
  await fs.mkdir(target.rootDir, { recursive: true });
  if (await exists(target.dir)) throw new Error(`Space already exists: ${target.name}`);
  await fs.mkdir(target.dir, { recursive: false });
  let clonedFrom = null;
  try {
    if (cloneFrom) {
      const source = pathsFor(cloneFrom, root);
      if (!(await exists(source.profileDir))) throw new Error(`Source space does not exist: ${source.name}`);
      await fs.cp(source.profileDir, target.profileDir, { recursive: true, force: false, errorOnExist: true });
      clonedFrom = source.name;
    } else {
      await fs.mkdir(target.profileDir, { recursive: true });
    }
    const manifest = {
      schemaVersion: 1,
      name: target.name,
      createdAt: new Date().toISOString(),
      clonedFrom
    };
    await writeManifest(target, manifest);
    return { ...manifest, dir: target.dir, profileDir: target.profileDir };
  } catch (error) {
    await fs.rm(target.dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function ensureSpace(name, options = {}) {
  const target = pathsFor(name, options.root);
  if (!(await exists(target.dir))) return await createSpace(name, options);
  if (!(await exists(target.profileDir))) await fs.mkdir(target.profileDir, { recursive: true });
  const manifest = await readManifest(target);
  return { ...manifest, dir: target.dir, profileDir: target.profileDir };
}

export async function listSpaces({ root } = {}) {
  const rootDir = rootPath(root);
  let entries;
  try { entries = await fs.readdir(rootDir, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const spaces = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.runs') continue;
    let target;
    try { target = pathsFor(entry.name, rootDir); } catch { continue; }
    const manifest = await readManifest(target);
    spaces.push({ ...manifest, name: target.name, dir: target.dir, profileDir: target.profileDir, locked: await exists(target.lockPath) });
  }
  return spaces.sort((a, b) => a.name.localeCompare(b.name));
}

async function acquireLock(target) {
  try {
    const handle = await fs.open(target.lockPath, 'wx');
    const payload = { pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString() };
    await handle.writeFile(JSON.stringify(payload) + '\n', 'utf8');
    await handle.close();
    return async () => { await fs.rm(target.lockPath, { force: true }).catch(() => {}); };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let detail = '';
    try { detail = (await fs.readFile(target.lockPath, 'utf8')).trim(); } catch {}
    throw new Error(`Space is already in use: ${target.name}${detail ? ` (${detail})` : ''}`);
  }
}

export async function prepareRunSpace({ name, root, mode = 'persistent', runId, keepClone = false } = {}) {
  if (!name) return null;
  const base = await ensureSpace(name, { root });
  const target = pathsFor(base.name, root);
  if (mode === 'persistent') {
    const release = await acquireLock(target);
    return {
      info: { name: base.name, mode, persistent: true, clonedFrom: base.clonedFrom || null },
      profileDir: base.profileDir,
      async cleanup() { await release(); }
    };
  }
  if (mode !== 'clone') throw new Error(`Unsupported space mode: ${mode}`);
  const runsRoot = path.join(target.rootDir, '.runs');
  await fs.mkdir(runsRoot, { recursive: true });
  const suffix = crypto.randomBytes(4).toString('hex');
  const safeRun = String(runId || Date.now()).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const runDir = path.join(runsRoot, `${safeRun}-${base.name}-${suffix}`);
  const profileDir = path.join(runDir, 'profile');
  await fs.mkdir(runDir, { recursive: false });
  await fs.cp(base.profileDir, profileDir, { recursive: true, force: false, errorOnExist: true });
  return {
    info: { name: base.name, mode, persistent: false, clonedFrom: base.name, runDir, keepClone: Boolean(keepClone) },
    profileDir,
    async cleanup() {
      if (!keepClone) await fs.rm(runDir, { recursive: true, force: true });
    }
  };
}
