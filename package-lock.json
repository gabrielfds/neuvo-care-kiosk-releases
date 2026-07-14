const { app, Menu, Tray, shell, BrowserWindow, nativeImage, ipcMain } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const log = require('electron-log');
const AutoLaunch = require('auto-launch');
const { autoUpdater } = require('electron-updater');

const APP_NAME = 'Neuvo Care Kiosk';
const BASE_KIOSK_URL = 'https://appcare.neuvo.com.br/kiosk';
const PORT = 8765;

// --- Config persistence ---
function getConfigPath() {
  return path.join(app.getPath('userData'), 'kiosk-config.json');
}
function readConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}
function writeConfig(config) {
  try { fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8'); } catch {}
}
function clearConfig() {
  try { fs.unlinkSync(getConfigPath()); } catch {}
}
function getKioskUrl() {
  const cfg = readConfig();
  if (cfg?.slug) return `https://${cfg.slug}.appcare.neuvo.com.br/kiosk`;
  return process.env.NEUVO_CARE_KIOSK_URL || BASE_KIOSK_URL;
}

let tray = null;
let kioskWindow = null;
let bridgeProcess = null;
let bridgeState = { serverStarted: false, readerConnected: false, readerName: null, clients: 0, port: PORT };
let bridgeError = null;
let menuRefreshTimer = null;
let kioskRestartTimer = null;

log.transports.file.level = 'info';
log.transports.console.level = 'info';

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    log.info('Second instance attempted. Existing instance remains active.');
    if (kioskWindow && !kioskWindow.isDestroyed()) kioskWindow.focus();
    tray?.displayBalloon?.({ title: APP_NAME, content: 'O Kiosk Neuvo Care já está em execução.' });
  });
}

function getLogPath() { return log.transports.file.getFile().path; }
function openLogs() {
  const logPath = getLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  shell.showItemInFolder(logPath);
}
function createIcon() {
  const preferredIcons = [
    path.join(__dirname, '..', 'assets', 'icon.png'),
    path.join(__dirname, '..', 'assets', 'icon.ico')
  ];
  for (const iconPath of preferredIcons) {
    if (fs.existsSync(iconPath)) {
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
    }
  }
  return nativeImage.createEmpty();
}
function statusLabel() {
  if (bridgeError) return 'Erro no bridge — veja logs';
  if (!bridgeState.serverStarted) return 'Iniciando...';
  if (!bridgeState.readerConnected) return 'Ativo — leitor NFC desconectado';
  return `Leitor NFC: ${bridgeState.readerName || 'conectado'}`;
}

function createKioskWindow() {
  if (kioskWindow && !kioskWindow.isDestroyed()) return;
  kioskWindow = new BrowserWindow({
    fullscreen: true,
    kiosk: false,         // kiosk:true bloqueia Alt+F4 e task manager
    autoHideMenuBar: true,
    backgroundColor: '#0B0F1A',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Ctrl+Shift+Q = saída de administrador sem precisar da bandeja
  kioskWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key === 'Q') {
      event.preventDefault();
      kioskWindow?.removeAllListeners('closed');
      app.quit();
    }
  });

  // Aguarda bridge subir antes de carregar (evita "não instalado" no banner)
  const loadUrl = () => kioskWindow?.loadURL(getKioskUrl());
  if (!bridgeState.serverStarted) {
    setTimeout(loadUrl, 3000);
  } else {
    loadUrl();
  }

  kioskWindow.webContents.on('did-fail-load', (_, errorCode) => {
    if (Math.abs(errorCode) === 3) return;
    log.warn('Kiosk failed to load, retrying in 5s', { errorCode });
    clearTimeout(kioskRestartTimer);
    kioskRestartTimer = setTimeout(() => {
      if (kioskWindow && !kioskWindow.isDestroyed()) kioskWindow.reload();
    }, 5000);
  });
  kioskWindow.on('closed', () => {
    kioskWindow = null;
    log.warn('Kiosk window closed — reopening in 2s');
    clearTimeout(kioskRestartTimer);
    kioskRestartTimer = setTimeout(createKioskWindow, 2000);
  });
  log.info('Kiosk window opened', getKioskUrl());
}

function rebuildMenu() {
  if (!tray) return;
  const winAlive = kioskWindow && !kioskWindow.isDestroyed();
  const menu = Menu.buildFromTemplate([
    { label: statusLabel(), enabled: false },
    { label: `Clientes WS: ${bridgeState.clients || 0}`, enabled: false },
    { label: bridgeProcess ? `Bridge PID: ${bridgeProcess.pid}` : 'Bridge: parado', enabled: false },
    { type: 'separator' },
    { label: winAlive ? 'Mostrar Kiosk' : 'Abrir Kiosk', click: () => {
      if (winAlive) kioskWindow.focus();
      else { clearTimeout(kioskRestartTimer); createKioskWindow(); }
    }},
    { label: 'Abrir status local', click: () => shell.openExternal(`http://localhost:${PORT}/status`) },
    { label: 'Abrir pasta de logs', click: openLogs },
    { type: 'separator' },
    { label: 'Reiniciar Bridge NFC', click: restartBridgeProcess },
    { label: 'Reiniciar Kiosk', click: () => {
      kioskWindow?.removeAllListeners('closed');
      kioskWindow?.destroy();
      clearTimeout(kioskRestartTimer);
      setTimeout(createKioskWindow, 500);
    }},
    { label: 'Deslogar / Trocar clínica', click: () => {
      log.info('Logout requested from tray');
      if (kioskWindow && !kioskWindow.isDestroyed()) {
        // Renderer will sign out of Supabase and clear config via IPC
        kioskWindow.webContents.send('kiosk:logout-request');
      }
    }},
    { type: 'separator' },
    { label: 'Sair', click: () => {
      kioskWindow?.removeAllListeners('closed'); // prevent auto-reopen
      app.quit();
    }},
  ]);
  tray.setToolTip(`${APP_NAME} — ${statusLabel()}`);
  tray.setContextMenu(menu);
}
function startBridgeProcess() {
  bridgeError = null;
  bridgeState = { serverStarted: false, readerConnected: false, readerName: null, clients: 0, port: PORT };
  const childPath = path.join(__dirname, 'bridge-child.js');
  log.info('Starting bridge child process', childPath);
  bridgeProcess = fork(childPath, [], {
    execPath: process.execPath,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NEUVO_CARE_BRIDGE_PORT: String(PORT)
    }
  });
  const startupTimer = setTimeout(() => {
    if (bridgeProcess && !bridgeState.serverStarted) {
      bridgeError = 'Bridge filho abriu, mas não respondeu em 8s. Veja logs.';
      log.error(bridgeError);
      rebuildMenu();
    }
  }, 8000);
  bridgeProcess.stdout?.on('data', (d) => log.info(`[bridge-child] ${String(d).trim()}`));
  bridgeProcess.stderr?.on('data', (d) => log.error(`[bridge-child] ${String(d).trim()}`));
  bridgeProcess.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'started' || msg.type === 'state') {
      bridgeState = { ...bridgeState, ...(msg.state || {}) };
      clearTimeout(startupTimer);
      bridgeError = null;
      rebuildMenu();
    }
    if (msg.type === 'error') {
      clearTimeout(startupTimer);
      bridgeError = msg.message || 'Erro desconhecido no bridge';
      log.error('[bridge-child]', bridgeError);
      rebuildMenu();
    }
    if (msg.type === 'log') log[msg.level || 'info']?.(`[bridge-child] ${msg.message}`);
  });
  bridgeProcess.on('exit', (code, signal) => {
    log.warn('Bridge child exited', { code, signal });
    bridgeProcess = null;
    bridgeState = { ...bridgeState, serverStarted: false, readerConnected: false, clients: 0 };
    clearTimeout(startupTimer);
    if (code !== 0) bridgeError = `Processo bridge saiu com código ${code || signal}`;
    rebuildMenu();
  });
  rebuildMenu();
}
function restartBridgeProcess() {
  if (bridgeProcess) {
    const old = bridgeProcess;
    bridgeProcess = null;
    old.kill();
  }
  setTimeout(startBridgeProcess, 700);
}
function setupAutoUpdater() {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    log.info('Update available', info.version);
    tray?.displayBalloon?.({ title: APP_NAME, content: `Nova versão ${info.version} disponível. Baixando...` });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded', info.version);
    tray?.displayBalloon?.({ title: APP_NAME, content: `Versão ${info.version} pronta. Será instalada ao sair.` });
  });

  autoUpdater.on('error', (err) => log.error('Auto-updater error', err));

  // Check on startup and then every 4 hours
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 4 * 60 * 60 * 1000);
}

async function setupAutoLaunch() {
  try {
    const launcher = new AutoLaunch({ name: APP_NAME, path: app.getPath('exe') });
    if (!(await launcher.isEnabled())) await launcher.enable();
  } catch (error) { log.warn('Auto-launch setup failed', error); }
}

// IPC handlers for config (called from preload/renderer)
ipcMain.handle('kiosk:save-config', (_, config) => {
  writeConfig(config);
  log.info('Kiosk config saved', config);
});
ipcMain.handle('kiosk:clear-config', () => {
  clearConfig();
  log.info('Kiosk config cleared');
});
ipcMain.handle('kiosk:get-config', () => readConfig());
ipcMain.handle('kiosk:quit', () => {
  kioskWindow?.removeAllListeners('closed');
  app.quit();
});

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    tray = new Tray(createIcon());
    tray.on('click', () => {
      if (kioskWindow && !kioskWindow.isDestroyed()) kioskWindow.focus();
      else { clearTimeout(kioskRestartTimer); createKioskWindow(); }
    });
    rebuildMenu();
    await setupAutoLaunch();
    startBridgeProcess();
    createKioskWindow();
    menuRefreshTimer = setInterval(rebuildMenu, 5000);
    setupAutoUpdater();
  });
  app.on('window-all-closed', (e) => e.preventDefault()); // keep alive in tray
  app.on('before-quit', () => {
    if (menuRefreshTimer) clearInterval(menuRefreshTimer);
    clearTimeout(kioskRestartTimer);
    if (bridgeProcess) bridgeProcess.kill();
  });
}
