import fs from 'node:fs/promises';
import path from 'node:path';

const fixtureRoot = path.resolve(process.argv[2] || '.ferrum/tauri-fixture/v2');
const cargoPath = path.join(fixtureRoot, 'src-tauri', 'Cargo.toml');
const libPath = path.join(fixtureRoot, 'src-tauri', 'src', 'lib.rs');
const capabilityPath = path.join(fixtureRoot, 'src-tauri', 'capabilities', 'default.json');

const pluginVersion = process.env.FERRUM_TAURI_EMBEDDED_PLUGIN_VERSION || '1.3.0';
const tauriVersion = process.env.FERRUM_TAURI_EMBEDDED_TAURI_VERSION || '2.11.5';
const tauriBuildVersion = process.env.FERRUM_TAURI_EMBEDDED_TAURI_BUILD_VERSION || '2.6.0';

let cargo = await fs.readFile(cargoPath, 'utf8');
const cargoEol = cargo.includes('\r\n') ? '\r\n' : '\n';
const tauriBuildPattern = /tauri-build\s*=\s*\{\s*version\s*=\s*"[^"]+"\s*,\s*features\s*=\s*\[\s*\]\s*\}/;
const tauriPattern = /^tauri\s*=\s*\{\s*version\s*=\s*"[^"]+"\s*,\s*features\s*=\s*\[\s*\]\s*\}/m;
if (!tauriBuildPattern.test(cargo)) throw new Error('Pinned Tauri fixture Cargo.toml no longer has the expected tauri-build dependency');
if (!tauriPattern.test(cargo)) throw new Error('Pinned Tauri fixture Cargo.toml no longer has the expected tauri dependency');
cargo = cargo.replace(tauriBuildPattern, `tauri-build = { version = "=${tauriBuildVersion}", features = [] }`);
cargo = cargo.replace(tauriPattern, `tauri = { version = "=${tauriVersion}", features = [] }`);
if (!cargo.includes('tauri-plugin-wdio-webdriver')) {
  cargo = `${cargo.trimEnd()}${cargoEol}${cargoEol}[target.'cfg(debug_assertions)'.dependencies]${cargoEol}tauri-plugin-wdio-webdriver = "=${pluginVersion}"${cargoEol}`;
}
await fs.writeFile(cargoPath, cargo);

let lib = await fs.readFile(libPath, 'utf8');
if (!lib.includes('tauri_plugin_wdio_webdriver::init()')) {
  const libEol = lib.includes('\r\n') ? '\r\n' : '\n';
  const builderPattern = /    tauri::Builder::default\(\)\r?\n        \.plugin\(tauri_plugin_opener::init\(\)\)/;
  const replacement = [
    '    let builder = tauri::Builder::default();',
    '',
    '    #[cfg(debug_assertions)]',
    '    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());',
    '',
    '    builder',
    '        .plugin(tauri_plugin_opener::init())'
  ].join(libEol);
  if (!builderPattern.test(lib)) throw new Error('Pinned Tauri fixture lib.rs no longer matches the expected builder shape');
  lib = lib.replace(builderPattern, replacement);
  await fs.writeFile(libPath, lib);
}

const capability = JSON.parse(await fs.readFile(capabilityPath, 'utf8'));
capability.permissions ??= [];
if (!capability.permissions.includes('wdio-webdriver:default')) {
  capability.permissions.push('wdio-webdriver:default');
  const capabilitySource = await fs.readFile(capabilityPath, 'utf8');
  const capabilityEol = capabilitySource.includes('\r\n') ? '\r\n' : '\n';
  await fs.writeFile(capabilityPath, `${JSON.stringify(capability, null, 2).replaceAll('\n', capabilityEol)}${capabilityEol}`);
}

const summary = {
  fixtureRoot,
  plugin: 'tauri-plugin-wdio-webdriver',
  pluginVersion,
  tauriVersion,
  tauriBuildVersion,
  cargoPatched: cargo.includes(`tauri-plugin-wdio-webdriver = "=${pluginVersion}"`),
  tauriPinned: cargo.includes(`tauri = { version = "=${tauriVersion}", features = [] }`),
  tauriBuildPinned: cargo.includes(`tauri-build = { version = "=${tauriBuildVersion}", features = [] }`),
  builderPatched: lib.includes('tauri_plugin_wdio_webdriver::init()'),
  permissionPatched: capability.permissions.includes('wdio-webdriver:default')
};

if (!summary.cargoPatched || !summary.tauriPinned || !summary.tauriBuildPinned || !summary.builderPatched || !summary.permissionPatched) {
  throw new Error(`Embedded Tauri fixture patch incomplete: ${JSON.stringify(summary)}`);
}

process.stdout.write(`${JSON.stringify(summary)}\n`);
