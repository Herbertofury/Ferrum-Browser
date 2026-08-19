import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outputRoot = path.resolve('artifacts/api-stateful/gamesync-recovery');
fs.mkdirSync(outputRoot, { recursive: true });

function run(command, args, cwd, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: options.timeout ?? 600_000,
    env: { ...process.env, CI: '1' },
  });
}

function cloneExact(repository, ref, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ferrum-${name}-`));
  run('git', ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${repository}.git`, root], process.cwd(), { timeout: 180_000 });
  run('git', ['fetch', '--depth=1', 'origin', ref], root, { timeout: 180_000 });
  run('git', ['checkout', '--detach', ref], root, { timeout: 60_000 });
  const actual = String(run('git', ['rev-parse', 'HEAD'], root, { capture: true })).trim();
  if (actual !== ref) throw new Error(`${name}: expected ${ref}, got ${actual}`);
  return root;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const results = {};

{
  const name = 'gamesync-vite';
  const ref = '8178577420ba9c540883c4dbac4634ed087f7788';
  const root = cloneExact('Herbertofury/Gamesync', ref, name);
  run('git', ['fetch', 'origin', 'main'], root, { timeout: 120_000 });
  const mergeBase = String(run('git', ['merge-base', 'HEAD', 'origin/main'], root, { capture: true })).trim();
  const main = String(run('git', ['rev-parse', 'origin/main'], root, { capture: true })).trim();
  if (mergeBase !== main) throw new Error(`${name}: candidate is stale relative to main ${main}`);
  run('npm', ['ci'], root);
  run('npm', ['audit', '--audit-level=critical'], root);
  run('npm', ['run', 'build'], root);
  run('npm', ['run', 'test:bounty'], root);
  run('git', ['diff', '--check', 'origin/main...HEAD'], root);
  results[name] = { repository: 'Herbertofury/Gamesync', ref, main, mergeBase, status: 'passed' };
}

{
  const name = 'gamesync-idb-keyval-lock';
  const ref = '3bf322c09c2e4d5af9d3947739f40aa0e2ea4bc8';
  const root = cloneExact('Herbertofury/Gamesync', ref, name);
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], root);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], root);
  const lockPath = path.join(root, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const rootRange = lock.packages?.['']?.dependencies?.['idb-keyval'];
  const resolved = lock.packages?.['node_modules/idb-keyval']?.version;
  if (rootRange !== '^6.3.0') throw new Error(`${name}: expected root idb-keyval ^6.3.0, got ${rootRange}`);
  if (resolved !== '6.3.0') throw new Error(`${name}: expected resolved idb-keyval 6.3.0, got ${resolved}`);
  const target = path.join(outputRoot, 'gamesync-idb-keyval-package-lock.json');
  fs.copyFileSync(lockPath, target);
  results[name] = {
    repository: 'Herbertofury/Gamesync',
    ref,
    rootRange,
    resolved,
    lockSha256: sha256(target),
    status: 'passed',
  };
}

fs.writeFileSync(path.join(outputRoot, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(results, null, 2));
