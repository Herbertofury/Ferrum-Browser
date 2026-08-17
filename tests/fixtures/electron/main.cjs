const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

ipcMain.handle('ferrum-ping', () => {
  console.log(`ferrum-electron-ping:${process.versions.electron}`);
  return { ok: true, electron: process.versions.electron };
});

app.whenReady().then(async () => {
  console.log(`ferrum-electron-main-ready:${process.versions.electron}`);
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  await win.loadFile(path.join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
