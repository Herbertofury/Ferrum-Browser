import os from 'node:os';

export function collectRuntimeMetadata() {
  const cpus = os.cpus() || [];
  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    v8: process.versions.v8,
    cpuModel: cpus[0]?.model || null,
    logicalCpuCount: cpus.length,
    totalMemoryBytes: os.totalmem()
  };
}
