const { app, Menu, Tray, shell, dialog, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const log = require('electron-log');
const AutoLaunch = require('auto-launch');
const { autoUpdater } = require('electron-updater');
const { startBridge, getBridgeState, stopBridge } = require('./bridge');

const KIOSK_URL = process.env.NEUVO_CARE_KIOSK_URL || 'https://appcare.neuvo.com.br/kiosk';
const OPEN_KIOSK_ON_STARTUP = process.env.NEUVO_CARE_OPEN_KIOSK_ON_STARTUP !== 'false';

let tray = null;
let bridgeHandle = null;
let menuRefreshTimer = null;
let kioskOpenedByThisInstance = false;
let updateCheckInProgress = false;
let manualUpdateCheck = false;

log.transports.file.level = 'info';
log.transports.console.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  log.info('Another Neuvo Care Kiosk Bridge instance is already running. Exiting duplicate instance.');
  app.quit();
} else {
  app.on('second-instance', () => {
    log.info('Second instance attempted. Keeping existing bridge instance only.');
    rebuildMenu();

    if (manualUpdateCheck) return;

    if (tray) {
      tray.displayBalloon?.({
        title: 'Neuvo Care Kiosk Bridge',
        content: 'O Bridge já está em execução na bandeja do Windows.'
      });
    }
  });
}

function getLogPath() {
  return log.transports.file.getFile().path;
}

function openLogs() {
  const logPath = getLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  shell.showItemInFolder(logPath);
}

function createIcon() {
  const preferredIcons = [
    path.join(__dirname, '..', 'assets', 'tray.png'),
    path.join(__dirname, '..', 'assets', 'icon.png')
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
  const state = getBridgeState();
  if (!state.serverStarted) return 'Bridge parado';
  if (!state.readerConnected) return 'Bridge ativo, leitor desconectado';
  return `Bridge conectado: ${state.readerName || 'leitor NFC'}`;
}

function openKiosk({ force = false } = {}) {
  if (!force && kioskOpenedByThisInstance) {
    log.info('Kiosk already opened by this Bridge instance; skipping duplicate open.');
    return;
  }

  kioskOpenedByThisInstance = true;
  shell.openExternal(KIOSK_URL).catch((err) => {
    log.warn('Could not open kiosk', err);
    kioskOpenedByThisInstance = false;
  });
}

function rebuildMenu() {
  if (!tray) return;
  const state = getBridgeState();
  const menu = Menu.buildFromTemplate([
    { label: statusLabel(), enabled: false },
    { label: `Clientes web: ${state.clients || 0}`, enabled: false },
    { type: 'separator' },
    { label: 'Abrir Kiosk Neuvo Care', click: () => openKiosk({ force: true }) },
    { label: 'Abrir status local', click: () => shell.openExternal('http://localhost:8765/status') },
    { label: 'Abrir pasta de logs', click: openLogs },
    { type: 'separator' },
    { label: updateCheckInProgress ? 'Checando atualização...' : 'Checar atualização', enabled: !updateCheckInProgress, click: () => checkForUpdates(true) },
    { label: 'Reiniciar Bridge', click: async () => { await restartBridge(); } },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
  tray.setToolTip(`Neuvo Care Kiosk Bridge - ${statusLabel()}`);
  tray.setContextMenu(menu);
}

async function restartBridge() {
  try {
    if (bridgeHandle) await stopBridge();
    bridgeHandle = await startBridge({ logger: log, onStateChange: rebuildMenu });
    log.info('Bridge restarted');
  } catch (error) {
    log.error('Bridge restart failed', error);
    dialog.showErrorBox('Neuvo Care Kiosk Bridge', `Falha ao iniciar bridge: ${error.message || error}`);
  } finally {
    rebuildMenu();
  }
}

async function setupAutoLaunch() {
  try {
    const launcher = new AutoLaunch({ name: 'Neuvo Care Kiosk Bridge', path: app.getPath('exe') });
    const enabled = await launcher.isEnabled();
    if (!enabled) await launcher.enable();
    log.info('Auto-launch enabled');
  } catch (error) {
    log.warn('Auto-launch setup failed', error);
  }
}

function setupAutoUpdaterEvents() {
  autoUpdater.on('checking-for-update', () => {
    updateCheckInProgress = true;
    log.info('Checking for updates');
    rebuildMenu();
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Update available', info);
    if (manualUpdateCheck) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Neuvo Care Kiosk Bridge',
        message: 'Atualização encontrada',
        detail: `Baixando versão ${info.version || 'mais recente'} em segundo plano.`
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('No update available', info);
    if (manualUpdateCheck) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Neuvo Care Kiosk Bridge',
        message: 'Nenhuma atualização disponível',
        detail: `Versão atual: ${app.getVersion()}`
      });
    }
  });

  autoUpdater.on('error', (error) => {
    log.warn('Update check failed', error);
    if (manualUpdateCheck) {
      dialog.showErrorBox(
        'Neuvo Care Kiosk Bridge',
        `Falha ao checar atualização. Verifique a internet e os logs do Bridge.\n\nDetalhe: ${error.message || error}`
      );
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded', info);
    dialog.showMessageBox({
      type: 'info',
      buttons: ['Instalar agora', 'Instalar ao sair'],
      defaultId: 0,
      cancelId: 1,
      title: 'Neuvo Care Kiosk Bridge',
      message: 'Atualização pronta para instalar',
      detail: `A versão ${info.version || 'mais recente'} foi baixada.`
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });
}

async function checkForUpdates(manual = false) {
  if (updateCheckInProgress) return;

  manualUpdateCheck = manual;

  try {
    if (!app.isPackaged) {
      log.info('Skipping update check because app is not packaged.');
      if (manual) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Neuvo Care Kiosk Bridge',
          message: 'Atualização disponível apenas no app instalado',
          detail: 'O auto-update não roda em ambiente de desenvolvimento.'
        });
      }
      return;
    }

    await autoUpdater.checkForUpdates();
  } catch (error) {
    log.warn('Update check failed', error);
    if (manual) {
      dialog.showErrorBox(
        'Neuvo Care Kiosk Bridge',
        `Falha ao checar atualização. Verifique a internet e os logs do Bridge.\n\nDetalhe: ${error.message || error}`
      );
    }
  } finally {
    updateCheckInProgress = false;
    setTimeout(() => { manualUpdateCheck = false; }, 1000);
    rebuildMenu();
  }
}

if (gotSingleInstanceLock) {
app.whenReady().then(async () => {
  app.setLoginItemSettings({ openAtLogin: true });
  tray = new Tray(createIcon());
  setupAutoUpdaterEvents();
  rebuildMenu();
  await setupAutoLaunch();
  await restartBridge();
  if (OPEN_KIOSK_ON_STARTUP) openKiosk();
  menuRefreshTimer = setInterval(rebuildMenu, 5000);
  checkForUpdates(false);
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('before-quit', async () => {
  if (menuRefreshTimer) clearInterval(menuRefreshTimer);
  try { await stopBridge(); } catch {}
});
}

