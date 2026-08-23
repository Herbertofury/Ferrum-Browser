import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function resolveFrom(baseDir, value) {
  const expanded = expandHome(value);
  if (!expanded || path.isAbsolute(expanded)) return expanded;
  return path.resolve(baseDir, expanded);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function safeName(value) {
  let name = String(value || 'run')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/[. ]+$/g, '');

  if (!name) return 'run';
  if (WINDOWS_RESERVED_DEVICE_NAME.test(name)) name = `_${name}`;
  return name.slice(0, 80) || 'run';
}

export function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}
