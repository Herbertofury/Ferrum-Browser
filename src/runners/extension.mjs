import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashDirectory } from '../core/hash.mjs';
import { launchChromiumSession } from '../browser/chromium.mjs';
import { StepEngine } from './step-engine.mjs';


function extensionIdFromManifestKey(key) {
  if (!key) return null;
  const digest = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16);
  const alphabet = 'abcdefghijklmnop';
  return [...digest].map(byte => alphabet[byte >> 4] + alphabet[byte & 15]).join('');
}

async function readManifest(extensionPath) {
  const file = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  if (manifest.manifest_version !== 3) throw new Error(`Ferrum extension lane currently requires Manifest V3; got ${manifest.manifest_version}`);
  return manifest;
}

async function resolveExtensionId(context, manifest, timeoutMs = 15000) {
  const keyedId = extensionIdFromManifestKey(manifest.key);
  if (keyedId) return keyedId;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workers = context.serviceWorkers();
    for (const worker of workers) {
      const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(worker.url());
      if (match) return match[1];
    }
    for (const page of context.pages()) {
      const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(page.url());
      if (match) return match[1];
    }
    if (manifest.background?.service_worker) {
      await context.newPage().then(page => page.close()).catch(() => {});
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Could not resolve loaded extension ID from Chromium runtime targets');
}

export async function runExtensionTarget(spec, evidence, options = {}) {
  const extensionPath = spec.target.path;
  const stat = await fs.stat(extensionPath).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Extension path is not a directory: ${extensionPath}`);
  const manifest = await readManifest(extensionPath);
  const digest = await hashDirectory(extensionPath);
  evidence.record('extension-build', { path: extensionPath, name: manifest.name, version: manifest.version, sha256: digest.sha256, fileCount: digest.files.length });
  await evidence.writeJson('extension-inventory.json', digest);

  const headless = options.headless ?? spec.target.headless ?? false;
  const profileDir = spec.target.profileDir ? path.resolve(spec.target.profileDir) : path.join(evidence.dir, 'profile');
  let session;
  let extensionId;
  let page;

  const launch = async () => {
    const launched = await launchChromiumSession({
      profileDir,
      headless,
      executablePath: spec.target.executable,
      extensionPath,
      browserArgs: spec.target.args || [],
      evidence
    });
    const id = await resolveExtensionId(launched.context, manifest, spec.timeouts?.startupMs || 20000);
    evidence.record('extension-loaded', { extensionId: id, profileDir, sha256: digest.sha256 });
    const activePage = launched.context.pages().find(candidate => !candidate.url().startsWith('chrome-extension://')) || launched.context.pages()[0] || await launched.newPage();
    return { session: launched, extensionId: id, page: activePage };
  };

  const first = await launch();
  session = first.session; extensionId = first.extensionId; page = first.page;
  let generation = 0;
  try {
    const stepEngine = new StepEngine({
      evidence,
      session,
      page,
      extensionId,
      extensionManifest: manifest,
      timeoutMs: spec.timeouts?.stepMs || 30000,
      onRestart: async () => {
        const trace = path.join(evidence.dir, `trace-${generation++}.zip`);
        await session.close(trace);
        const next = await launch();
        session = next.session;
        extensionId = next.extensionId;
        page = next.page;
        evidence.record('extension-restart-proof', { extensionId, sha256: digest.sha256, profileDir });
        return next;
      }
    });
    const result = await stepEngine.run(spec.steps);
    await session.close(path.join(evidence.dir, `trace-${generation}.zip`));
    return {
      engine: 'chromium-extension',
      extension: { id: extensionId, name: manifest.name, version: manifest.version, sha256: digest.sha256, fileCount: digest.files.length },
      ...result
    };
  } catch (error) {
    await session?.close(path.join(evidence.dir, `trace-failed-${generation}.zip`)).catch(() => {});
    throw error;
  }
}
