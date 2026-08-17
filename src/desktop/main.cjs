const path = require('node:path');
const { app, BrowserWindow } = require('electron');

let server = null;
let closing = false;

async function closeServer() {
  if (!server || closing) return;
  closing = true;
  const current = server;
  server = null;
  await new Promise(resolve => current.close(() => resolve()));
  closing = false;
}

async function createWindow() {
  const { startDashboard } = await import('../server/dashboard.mjs');
  const started = await startDashboard({
    port: 0,
    open: false,
    artifactsRoot: process.env.FERRUM_ARTIFACTS_ROOT || 'artifacts'
  });
  server = started.server;
  const win = new BrowserWindow({
    width: 1480,
    height: 1040,
    minWidth: 920,
    minHeight: 680,
    backgroundColor: '#070810',
    title: 'Ferrum Test Workbench',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await win.loadURL(started.url);
  return win;
}

app.whenReady().then(createWindow).catch(error => {
  console.error(error.stack || error);
  app.exit(1);
});

app.on('window-all-closed', async () => {
  await closeServer().catch(() => {});
  app.quit();
});

app.on('before-quit', event => {
  if (!server || closing) return;
  event.preventDefault();
  closeServer().finally(() => app.quit());
});
