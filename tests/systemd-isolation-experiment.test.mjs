import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { EvidenceWriter } from '../src/core/evidence.mjs';
import { runProcessTarget } from '../src/runners/process.mjs';

const execFile = promisify(execFileCallback);
const enabled = process.platform === 'linux' && process.env.CI === 'true';

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1));
  return ordered[index];
}

function systemdArgs(unit, command, args) {
  return [
    '-n',
    'systemd-run',
    '--wait',
    '--pipe',
    '--quiet',
    '--collect',
    '--service-type=exec',
    `--unit=${unit}`,
    `--uid=${process.getuid()}`,
    '--same-dir',
    '--property=NoNewPrivileges=yes',
    '--property=ProtectSystem=strict',
    '--property=ProtectHome=read-only',
    '--property=PrivateTmp=yes',
    '--property=PrivateDevices=yes',
    '--property=PrivateNetwork=yes',
    '--property=ProtectKernelTunables=yes',
    '--property=ProtectControlGroups=yes',
    '--property=ProtectKernelModules=yes',
    '--property=RestrictSUIDSGID=yes',
    '--property=LockPersonality=yes',
    '--property=RestrictRealtime=yes',
    '--property=RestrictAddressFamilies=AF_UNIX',
    '--property=CapabilityBoundingSet=',
    '--property=MemoryMax=256M',
    '--property=TasksMax=64',
    command,
    ...args
  ];
}

async function evidence(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-systemd-isolation-'));
  return new EvidenceWriter({ root, name }).init();
}

async function waitForUnitProperties(unit) {
  const propertyNames = [
    'ActiveState',
    'SubState',
    'NoNewPrivileges',
    'ProtectSystem',
    'ProtectHome',
    'PrivateTmp',
    'PrivateDevices',
    'PrivateNetwork',
    'ProtectKernelTunables',
    'ProtectControlGroups',
    'ProtectKernelModules',
    'RestrictSUIDSGID',
    'LockPersonality',
    'RestrictRealtime',
    'RestrictAddressFamilies',
    'MemoryMax',
    'TasksMax',
    'ControlGroup'
  ];
  const args = ['show', unit, ...propertyNames.flatMap(name => ['--property', name])];
  const deadline = Date.now() + 3000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFile('systemctl', args, { timeout: 1000 });
      const properties = Object.fromEntries(
        stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)];
        })
      );
      if (properties.ActiveState === 'active') return properties;
      last = properties;
    } catch (error) {
      last = { error: error.message };
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`systemd unit did not become observable: ${unit}: ${JSON.stringify(last)}`);
}

async function runPlain(index, script) {
  const writer = await evidence(`systemd-plain-${index}`);
  const started = performance.now();
  await runProcessTarget({
    target: { command: process.execPath, args: ['--input-type=module', '-e', script] },
    timeouts: { stepMs: 10000 },
    steps: [
      { action: 'assert-log', text: 'FERRUM_ALLOWED_WORKLOAD_OK' },
      { action: 'wait-exit', code: 0 }
    ]
  }, writer);
  return performance.now() - started;
}

async function runIsolated(index, script, inspect = false) {
  const writer = await evidence(`systemd-isolated-${index}`);
  const unit = `ferrum-isolation-${process.pid}-${Date.now()}-${index}`;
  const started = performance.now();
  const runPromise = runProcessTarget({
    target: {
      command: 'sudo',
      args: systemdArgs(unit, process.execPath, ['--input-type=module', '-e', script])
    },
    timeouts: { stepMs: 15000 },
    steps: [
      { action: 'assert-log', text: inspect ? 'FERRUM_ISOLATION_RESULT ' : 'FERRUM_ALLOWED_WORKLOAD_OK' },
      { action: 'wait-exit', code: 0 }
    ]
  }, writer);
  const propertiesPromise = inspect ? waitForUnitProperties(unit) : Promise.resolve(null);
  const [result, properties] = await Promise.all([runPromise, propertiesPromise]);
  return { elapsedMs: performance.now() - started, writer, result, properties };
}

test('systemd-run strict transient service preserves allowed Ferrum process work and enforces requested isolation', { skip: !enabled, timeout: 30000 }, async () => {
  const probeScript = `
    import fs from 'node:fs';
    import net from 'node:net';
    import path from 'node:path';
    const cwd = process.cwd();
    const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    let workspaceWriteDenied = false;
    let workspaceWriteError = null;
    try {
      fs.writeFileSync(path.join(cwd, '.ferrum-isolation-should-not-exist'), 'blocked');
    } catch (error) {
      workspaceWriteDenied = true;
      workspaceWriteError = error.code || error.name;
    }
    let tmpWriteWorked = false;
    const tmpPath = path.join('/tmp', 'ferrum-isolation-' + process.pid + '.txt');
    try {
      fs.writeFileSync(tmpPath, 'ok');
      tmpWriteWorked = fs.readFileSync(tmpPath, 'utf8') === 'ok';
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    const networkDenied = await new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; resolve(value); } };
      const socket = net.createConnection({ host: '1.1.1.1', port: 80 });
      const timer = setTimeout(() => { socket.destroy(); finish(true); }, 800);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); finish(false); });
      socket.once('error', () => { clearTimeout(timer); finish(true); });
    });
    console.log('FERRUM_ISOLATION_RESULT ' + JSON.stringify({
      packageName: packageJson.name,
      cwd,
      workspaceWriteDenied,
      workspaceWriteError,
      tmpWriteWorked,
      networkDenied,
      uid: process.getuid()
    }));
    await new Promise(resolve => setTimeout(resolve, 700));
  `;

  const isolated = await runIsolated('probe', probeScript, true);
  const resultEvent = isolated.writer.events.find(event => event.type === 'process-log' && event.text.includes('FERRUM_ISOLATION_RESULT '));
  assert.ok(resultEvent, 'expected structured isolation result in Ferrum process evidence');
  const result = JSON.parse(resultEvent.text.slice(resultEvent.text.indexOf('{')));
  assert.equal(result.packageName, 'ferrum-tester');
  assert.equal(result.cwd, process.cwd());
  assert.equal(result.workspaceWriteDenied, true, `workspace write unexpectedly succeeded: ${JSON.stringify(result)}`);
  assert.equal(result.tmpWriteWorked, true, 'PrivateTmp must remain writable for ordinary temporary-file workloads');
  assert.equal(result.networkDenied, true, 'strict profile must block AF_INET/AF_INET6 networking');
  assert.equal(result.uid, process.getuid(), 'isolated workload must keep the caller identity');

  const p = isolated.properties;
  assert.equal(p.NoNewPrivileges, 'yes');
  assert.equal(p.ProtectSystem, 'strict');
  assert.equal(p.ProtectHome, 'read-only');
  assert.equal(p.PrivateTmp, 'yes');
  assert.equal(p.PrivateDevices, 'yes');
  assert.equal(p.PrivateNetwork, 'yes');
  assert.equal(p.ProtectKernelTunables, 'yes');
  assert.equal(p.ProtectControlGroups, 'yes');
  assert.equal(p.ProtectKernelModules, 'yes');
  assert.equal(p.RestrictSUIDSGID, 'yes');
  assert.equal(p.LockPersonality, 'yes');
  assert.equal(p.RestrictRealtime, 'yes');
  assert.ok(p.ControlGroup, 'expected concrete systemd cgroup identity');
});

test('systemd-run strict transient isolation has bounded startup cost on the same allowed workload', { skip: !enabled, timeout: 60000 }, async () => {
  const script = `
    import fs from 'node:fs';
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    if (packageJson.name !== 'ferrum-tester') process.exit(17);
    console.log('FERRUM_ALLOWED_WORKLOAD_OK');
  `;
  const plain = [];
  const isolated = [];
  for (let index = 0; index < 7; index += 1) {
    plain.push(await runPlain(index, script));
    isolated.push((await runIsolated(index, script)).elapsedMs);
  }
  const metrics = {
    plainMedianMs: percentile(plain, 0.5),
    plainP95Ms: percentile(plain, 0.95),
    isolatedMedianMs: percentile(isolated, 0.5),
    isolatedP95Ms: percentile(isolated, 0.95)
  };
  metrics.medianOverheadMs = metrics.isolatedMedianMs - metrics.plainMedianMs;
  console.log(`FERRUM_SYSTEMD_ISOLATION_METRICS ${JSON.stringify(metrics)}`);
  assert.ok(metrics.isolatedMedianMs < 750, `isolated median startup cost is too high: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.isolatedP95Ms < 1500, `isolated p95 startup cost is too high: ${JSON.stringify(metrics)}`);
});
