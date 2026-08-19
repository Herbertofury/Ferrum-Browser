import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { TuiTest, VERSION, closeAll, sessions } from '@microsoft/tui-test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixture = path.join(root, 'scripts', 'tui-pty-fixture.mjs');
const artifacts = path.resolve(process.env.FERRUM_TUI_ARTIFACTS || path.join(root, 'artifacts', 'tui-pty-candidate', `${process.platform}-${process.arch}`));
const iterations = Number(process.env.FERRUM_TUI_ITERATIONS || 10);

if (!Number.isInteger(iterations) || iterations < 1) throw new Error('FERRUM_TUI_ITERATIONS must be a positive integer');
await fs.mkdir(artifacts, { recursive: true });

const publishedMethods = Object.getOwnPropertyNames(TuiTest.prototype).filter(name => name !== 'constructor').sort();
const requiredMethods = [
  'run', 'close', 'closeQuiet', 'type', 'write', 'press', 'resize', 'state', 'cells',
  'getCursor', 'getSize', 'screenshot', 'startRecording', 'stopRecording', 'waitText',
  'waitIdle', 'waitExit', 'expectText', 'expectExitCode'
];
const missingRequiredMethods = requiredMethods.filter(name => !publishedMethods.includes(name));
assert.deepEqual(missingRequiredMethods, [], `published tui-test candidate is missing required methods: ${missingRequiredMethods.join(', ')}`);

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

const results = [];
let failure = null;

try {
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const session = `ferrum-${process.platform}-${process.pid}-${index}`;
    const t = new TuiTest(session, {
      timeouts: { text: 5000, idle: 5000, command: 10000, exit: 10000, ready: 5000 },
      artifacts: { dir: artifacts, onFailure: 'svg' }
    });
    const castPath = path.join(artifacts, `${session}.cast`);
    const svgPath = path.join(artifacts, `${session}.svg`);
    try {
      const opened = await t.run(process.execPath, [fixture], {
        cwd: root,
        cols: 80,
        rows: 24,
        waitReady: false
      });
      assert.equal(opened.session, session);

      await t.waitText('READY');
      await t.expectText('TTY:yes');
      await t.waitText('ASYNC:ready');
      const initialSize = await t.getSize();
      assert.deepEqual(initialSize, { cols: 80, rows: 24 });
      const title = typeof t.getTitle === 'function' ? await t.getTitle() : null;
      if (title != null) assert.equal(title, 'Ferrum TUI Fixture');
      const bellCount = typeof t.getBellCount === 'function' ? await t.getBellCount() : null;
      if (bellCount != null) assert.ok(bellCount >= 1, 'fixture bell was not observed');

      await t.startRecording(castPath, { format: 'cast' });
      await t.press('Escape');
      await t.waitText('KEY:ESCAPE');
      await t.type('abc');
      await t.waitText('TYPE:abc');
      await t.resize(100, 30);
      await t.write('r');
      await t.waitText('SIZE:100x30');
      await t.waitIdle();

      const finalSize = await t.getSize();
      assert.deepEqual(finalSize, { cols: 100, rows: 30 });
      const cursor = await t.getCursor();
      assert.deepEqual(cursor, { x: 9, y: 9 });
      const firstCell = (await t.cells(0, 0, 1, 1))[0];
      assert.equal(firstCell?.char, 'F');
      assert.equal(firstCell?.bold, true);
      const state = await t.state();
      assert.equal(state.cols, 100);
      assert.equal(state.rows, 30);
      assert.ok(state.text.includes('TYPE:abc'));
      assert.ok(state.text.includes('KEY:ESCAPE'));

      await t.screenshot(svgPath);
      await t.stopRecording();
      const svg = await fs.stat(svgPath);
      const cast = await fs.stat(castPath);
      assert.ok(svg.size > 0, 'SVG screenshot is empty');
      assert.ok(cast.size > 0, 'asciicast recording is empty');

      await t.write('q');
      await t.waitExit();
      await t.expectExitCode(0);
      await t.close();
      const remaining = await sessions();
      assert.ok(!remaining.includes(session), `session leaked after close: ${session}`);

      results.push({
        iteration: index + 1,
        session,
        durationMs: Number((performance.now() - started).toFixed(3)),
        initialSize,
        finalSize,
        cursor,
        title,
        bellCount,
        screenshotBytes: svg.size,
        recordingBytes: cast.size
      });
    } catch (error) {
      failure = { iteration: index + 1, session, message: error.message, stack: error.stack };
      await t.closeQuiet();
      throw error;
    }
  }
} finally {
  await closeAll().catch(() => {});
}

const remainingSessions = await sessions();
assert.deepEqual(remainingSessions, [], `tui-test sessions remain after run: ${remainingSessions.join(', ')}`);
const durations = results.map(item => item.durationMs);
const summary = {
  schemaVersion: 1,
  candidate: '@microsoft/tui-test',
  candidateVersion: VERSION,
  publishedMethods,
  optionalSurface: {
    getTitle: publishedMethods.includes('getTitle'),
    getBellCount: publishedMethods.includes('getBellCount'),
    waitBell: publishedMethods.includes('waitBell')
  },
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  fixture,
  iterations,
  passed: results.length,
  successRate: results.length / iterations,
  medianMs: percentile(durations, 0.5),
  p95Ms: percentile(durations, 0.95),
  remainingSessions,
  failure,
  results
};

await fs.writeFile(path.join(artifacts, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
