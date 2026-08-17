import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveFrom } from './paths.mjs';

const TARGET_TYPES = new Set(['web', 'extension', 'electron', 'process', 'appium']);
const TEMPLATE = /\$\{(?:VAR|ENV):([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function expandVariables(value, variables = {}, label = 'value') {
  if (typeof value === 'string') {
    return value.replace(TEMPLATE, (_match, name) => {
      const resolved = variables[name] ?? process.env[name];
      if (resolved == null || resolved === '') throw new Error(`${label}: required variable ${name} is not set`);
      return String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item, index) => expandVariables(item, variables, `${label}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expandVariables(child, variables, `${label}.${key}`)]));
  }
  return value;
}

export async function loadSpec(specPath, options = {}) {
  const abs = path.resolve(specPath);
  const raw = JSON.parse(await fs.readFile(abs, 'utf8'));
  const expanded = expandVariables(raw, options.variables || {}, abs);
  const baseDir = path.dirname(abs);
  validateSpec(expanded, abs);
  const spec = structuredClone(expanded);
  spec.__file = abs;
  spec.__baseDir = baseDir;
  spec.__sourceSpec = structuredClone(raw);
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
