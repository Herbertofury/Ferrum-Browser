import fs from 'node:fs/promises';
import path from 'node:path';

const fixtureRoot = path.resolve(process.argv[2] || '.ferrum/tauri-fixture/v2');
const cargoPath = path.join(fixtureRoot, 'src-tauri', 'Cargo.toml');
const libPath = path.join(fixtureRoot, 'src-tauri', 'src', 'lib.rs');
const capabilityPath = path.join(fixtureRoot, 'src-tauri', 'capabilities', 'default.json');

const pluginVersion = process.env.FERRUM_TAURI_EMBEDDED_PLUGIN_VERSION || '1.0.0';

let cargo = await fs.readFile(cargoPath, 'utf8');
if (!cargo.includes('tauri-plugin-wdio-webdriver')) {
  cargo = `${cargo.trimEnd()}\n\n[target.'cfg(debug_assertions)'.dependencies]\ntauri-plugin-wdio-webdriver = "=${pluginVersion}"\n`;
  await fs.writeFile(cargoPath, cargo);
}

let lib = await fs.readFile(libPath, 'utf8');
if (!lib.includes('tauri_plugin_wdio_webdriver::init()')) {
  const needle = '    tauri::Builder::default()\n        .plugin(tauri_plugin_opener::init())';
  const replacement = [
    '    let builder = tauri::Builder::default();',
    '',
    '    #[cfg(debug_assertions)]',
    '    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());',
    '',
    '    builder',
    '        .plugin(tauri_plugin_opener::init())'
  ].join('\n');
  if (!lib.includes(needle)) throw new Error('Pinned Tauri fixture lib.rs no longer matches the expected builder shape');
  lib = lib.replace(needle, replacement);
  await fs.writeFile(libPath, lib);
}

const capability = JSON.parse(await fs.readFile(capabilityPath, 'utf8'));
capability.permissions ??= [];
if (!capability.permissions.includes('wdio-webdriver:default')) {
  capability.permissions.push('wdio-webdriver:default');
  await fs.writeFile(capabilityPath, `${JSON.stringify(capability, null, 2)}\n`);
}

const summary = {
  fixtureRoot,
  plugin: 'tauri-plugin-wdio-webdriver',
  pluginVersion,
  cargoPatched: cargo.includes(`tauri-plugin-wdio-webdriver = "=${pluginVersion}"`),
  builderPatched: lib.includes('tauri_plugin_wdio_webdriver::init()'),
  permissionPatched: capability.permissions.includes('wdio-webdriver:default')
};

if (!summary.cargoPatched || !summary.builderPatched || !summary.permissionPatched) {
  throw new Error(`Embedded Tauri fixture patch incomplete: ${JSON.stringify(summary)}`);
}

process.stdout.write(`${JSON.stringify(summary)}\n`);
