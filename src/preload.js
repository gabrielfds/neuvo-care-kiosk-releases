const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__neuvoKiosk', {
  native: true,
  version: '0.4.0',
  platform: process.platform,
  saveConfig: (config) => ipcRenderer.invoke('kiosk:save-config', config),
  clearConfig: () => ipcRenderer.invoke('kiosk:clear-config'),
  getConfig: () => ipcRenderer.invoke('kiosk:get-config'),
  quit: () => ipcRenderer.invoke('kiosk:quit'),
  onLogoutRequest: (cb) => { ipcRenderer.on('kiosk:logout-request', () => cb()); },
});
