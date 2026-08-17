const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ferrum', {
  ping: () => ipcRenderer.invoke('ferrum-ping')
});
