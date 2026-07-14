const { contextBridge, ipcRenderer } = require('electron');
const { version } = require('../package.json');

contextBridge.exposeInMainWorld('__neuvoKiosk', {
  native: true,
  version,
  platform: process.platform,
  saveConfig: (config) => ipcRenderer.invoke('kiosk:save-config', config),
  clearConfig: () => ipcRenderer.invoke('kiosk:clear-config'),
  getConfig: () => ipcRenderer.invoke('kiosk:get-config'),
});
