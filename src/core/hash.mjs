import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

async function listFiles(root, current = root, out = []) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.ferrum') continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) await listFiles(root, abs, out);
    else if (entry.isFile()) out.push(path.relative(root, abs).replaceAll('\\', '/'));
  }
  return out;
}

export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

export async function hashDirectory(root) {
  const files = (await listFiles(root)).sort();
  const hash = crypto.createHash('sha256');
  const inventory = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    const digest = await hashFile(abs);
    const stat = await fs.stat(abs);
    inventory.push({ path: rel, sha256: digest, size: stat.size });
    hash.update(rel);
    hash.update('\0');
    hash.update(digest);
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), files: inventory };
}
