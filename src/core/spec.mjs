import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveFrom } from './paths.mjs';

const TARGET_TYPES = new Set(['web', 'extension', 'electron', 'process', 'appium']);

export async function loadSpec(specPath) {
  const abs = path.resolve(specPath);
  const raw = JSON.parse(await fs.readFile(abs, 'utf8'));
  const baseDir = path.dirname(abs);
  validateSpec(raw, abs);
  const spec = structuredClone(raw);
  spec.__file = abs;
  spec.__baseDir = baseDir;
  if (spec.target?.path) spec.target.path = resolveFrom(baseDir, spec.target.path);
  if (spec.target?.cwd) spec.target.cwd = resolveFrom(baseDir, spec.target.cwd);
  if (spec.target?.executable) spec.target.executable = resolveFrom(baseDir, spec.target.executable);
  if (spec.artifacts?.root) spec.artifacts.root = resolveFrom(baseDir, spec.artifacts.root);
  return spec;
}

export function validateSpec(spec, label = 'spec') {
  if (!spec || typeof spec !== 'object') throw new Error(`${label}: root must be an object`);
  if (spec.version !== 1) throw new Error(`${label}: version must be 1`);
  if (!spec.name || typeof spec.name !== 'string') throw new Error(`${label}: name is required`);
  if (!spec.target || !TARGET_TYPES.has(spec.target.type)) {
    throw new Error(`${label}: target.type must be one of ${[...TARGET_TYPES].join(', ')}`);
  }
  if (!Array.isArray(spec.steps)) throw new Error(`${label}: steps must be an array`);
  for (const [index, step] of spec.steps.entries()) {
    if (!step || typeof step !== 'object' || typeof step.action !== 'string') {
      throw new Error(`${label}: steps[${index}].action is required`);
    }
  }
  return true;
}
