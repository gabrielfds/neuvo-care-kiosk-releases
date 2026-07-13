const { contextBridge } = require('electron');
const { version } = require('../package.json');

contextBridge.exposeInMainWorld('__neuvoKiosk', {
  native: true,
  version,
  platform: process.platform,
});
