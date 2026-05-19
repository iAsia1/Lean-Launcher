const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { loginAccount, getAuthAccounts, setActiveAuthAccount, removeAuthAccount } = require('./index.js');
const { autoUpdater } = require('electron-updater');
let mainWindow = null;

function copyDirectoryContentsRecursive(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return 0;
  fs.mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copied += copyDirectoryContentsRecursive(sourcePath, targetPath);
      continue;
    }

    if (!entry.isFile()) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    copied += 1;
  }

  return copied;
}

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.png');
  const win = new BrowserWindow({
    width: 950, height: 700,
    minWidth: 900, minHeight: 650,
    frame: false,
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
  return win;
}

function showOrCreateMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return createWindow();
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  // Auto-updater — checks GitHub Releases on launch + every 4 hours
  autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 60 * 60 * 1000);
});

// Notify renderer of update download progress
autoUpdater.on('download-progress', (progress) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-progress', progress.percent);
  }
});

// Update downloaded — prompt user to restart
autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Update Ready',
    message: 'A new version of Lean Launcher has been downloaded. Restart now to install it?',
    buttons: ['Restart', 'Later']
  }).then(({ response }) => {
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('login-account', async () => {
  try { return { success: true, result: await loginAccount() }; }
  catch (error) { return { success: false, error: error?.message || String(error) }; }
});

ipcMain.handle('launch-game', async (event, payload) => {
  const { startLeanClient, getGlobalSettings } = require('./index.js');
  const senderWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const closeOnBoot = Boolean(getGlobalSettings()?.closeOnBoot);

  try { 
    const result = await startLeanClient(payload, (msg, prog) => {
          event.sender.send('launch-update', { msg, prog });
      }, (launchEvent) => {
          if (!launchEvent || typeof launchEvent !== 'object') return;

          if (launchEvent.type === 'booted' && closeOnBoot && senderWindow && !senderWindow.isDestroyed()) {
            senderWindow.hide();
            return;
          }

          if (launchEvent.type === 'game-exit') {
            if (closeOnBoot) showOrCreateMainWindow();
            return;
          }

          if (launchEvent.type === 'crash') {
            const visibleWindow = showOrCreateMainWindow();
            visibleWindow.webContents.send('launch-crash-report', launchEvent.report || {});
          }
      });
      return { success: true, result }; 
  }
  catch (error) { return { success: false, error: error?.message || String(error) }; }
});

ipcMain.handle('cancel-launch', () => {
  const { cancelLaunchProcess } = require('./index.js');
  if (cancelLaunchProcess) cancelLaunchProcess();
  return { success: true };
});

ipcMain.handle('get-global-settings', () => require('./index.js').getGlobalSettings());
ipcMain.handle('save-global-settings', (_, glob) => require('./index.js').saveGlobalSettings(glob));

ipcMain.handle('get-auth-accounts', () => getAuthAccounts());

ipcMain.handle('get-settings', (_, version) => require('./index.js').getInstanceSettings(version));
ipcMain.handle('save-settings', (_, { version, settings }) => {
    const { loadSettings, saveSettings } = require('./index.js');
    const all = loadSettings();
    all[version] = settings;
    saveSettings(all);
    return { success: true };
});

ipcMain.handle('get-all-settings', () => require('./index.js').loadSettings());

ipcMain.handle('get-system-memory', () => {
  const totalBytes = os.totalmem();
  return { totalMb: Math.round(totalBytes / (1024 * 1024)) };
});

ipcMain.handle('validate-java-path', (_, javaPath) => {
  if (!javaPath || typeof javaPath !== 'string') return { valid: false, error: 'No path provided.' };
  if (!fs.existsSync(javaPath))
    return { valid: false, error: `Java executable not found at:\n${javaPath}` };
  return { valid: true };
});

ipcMain.handle('open-instance-folder', async (_, version) => {
  const instancePath = path.join(__dirname, 'minecraft', 'instances', version);
  if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath, { recursive: true });
  await shell.openPath(instancePath);
  return { success: true };
});

ipcMain.handle('delete-custom-version', (_, version) => {
  const { loadSettings, saveSettings } = require('./index.js');
  const all = loadSettings();
  delete all[version];
  saveSettings(all);

  const instancePath = path.join(__dirname, 'minecraft', 'instances', version);
  if (fs.existsSync(instancePath)) {
    fs.rmSync(instancePath, { recursive: true, force: true });
  }
  return { success: true };
});

ipcMain.handle('rename-custom-version', (_, { oldVersion, newVersion }) => {
  if (!oldVersion || !newVersion) return { success: false, error: 'Invalid version names' };
  if (oldVersion === newVersion) return { success: true };

  const { loadSettings, saveSettings } = require('./index.js');
  const all = loadSettings();

  if (!all[oldVersion]) return { success: false, error: 'Source version not found' };
  if (all[newVersion]) return { success: false, error: 'Target version already exists' };

  all[newVersion] = all[oldVersion];
  delete all[oldVersion];
  saveSettings(all);

  const oldInstancePath = path.join(__dirname, 'minecraft', 'instances', oldVersion);
  const newInstancePath = path.join(__dirname, 'minecraft', 'instances', newVersion);

  if (fs.existsSync(oldInstancePath) && !fs.existsSync(newInstancePath)) {
    fs.renameSync(oldInstancePath, newInstancePath);
  }

  return { success: true };
});

ipcMain.handle('list-instance-directory', (_, { version, relPath }) => {
  const basePath = path.resolve(__dirname, 'minecraft', 'instances', version);
  const targetPath = path.resolve(basePath, relPath || '.');

  if (!targetPath.startsWith(basePath)) return [];
  if (!fs.existsSync(targetPath)) return [];

  const dirents = fs.readdirSync(targetPath, { withFileTypes: true });
  return dirents
    .map(d => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      relPath: path.join(relPath || '', d.name).replace(/\\/g, '/'),
      size: d.isDirectory() ? null : fs.statSync(path.join(targetPath, d.name)).size,
      childCount: d.isDirectory() ? fs.readdirSync(path.join(targetPath, d.name)).length : null
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
});

ipcMain.handle('read-instance-file', (_, { version, relPath }) => {
  const basePath = path.resolve(__dirname, 'minecraft', 'instances', version);
  const targetPath = path.resolve(basePath, relPath || '.');

  if (!targetPath.startsWith(basePath)) return { success: false, error: 'Invalid path' };
  if (!fs.existsSync(targetPath)) return { success: false, error: 'File not found' };

  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) return { success: false, error: 'Path is a directory' };

  const content = fs.readFileSync(targetPath, 'utf-8');
  return { success: true, content };
});

ipcMain.handle('write-instance-file', (_, { version, relPath, content }) => {
  const basePath = path.resolve(__dirname, 'minecraft', 'instances', version);
  const targetPath = path.resolve(basePath, relPath || '.');

  if (!targetPath.startsWith(basePath)) return { success: false, error: 'Invalid path' };
  if (!fs.existsSync(targetPath)) return { success: false, error: 'File not found' };

  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) return { success: false, error: 'Path is a directory' };

  fs.writeFileSync(targetPath, String(content ?? ''), 'utf-8');
  return { success: true };
});

ipcMain.handle('upload-instance-files', async (_, { version, relPath }) => {
  const basePath = path.resolve(__dirname, 'minecraft', 'instances', version);
  const targetPath = path.resolve(basePath, relPath || '.');

  if (!targetPath.startsWith(basePath)) return { success: false, error: 'Invalid path' };
  if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });

  const result = await dialog.showOpenDialog({
    title: 'Upload folder',
    defaultPath: targetPath,
    properties: ['openDirectory', 'multiSelections']
  });

  if (result.canceled || !result.filePaths?.length) return { success: true, canceled: true };

  let copied = 0;
  for (const sourcePath of result.filePaths) {
    if (!fs.existsSync(sourcePath)) continue;
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      copied += copyDirectoryContentsRecursive(sourcePath, targetPath);
      continue;
    }
    if (!stat.isFile()) continue;
    const fileName = path.basename(sourcePath);
    const destinationPath = path.join(targetPath, fileName);
    fs.copyFileSync(sourcePath, destinationPath);
    copied += 1;
  }

  return { success: true, count: copied };
});

ipcMain.handle('copy-files-into-instance-folder', (_, { version, relPath, sourcePaths }) => {
  const basePath = path.resolve(__dirname, 'minecraft', 'instances', version);
  const targetPath = path.resolve(basePath, relPath || '.');

  if (!targetPath.startsWith(basePath)) return { success: false, error: 'Invalid path' };
  if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });

  const files = Array.isArray(sourcePaths) ? sourcePaths.filter(Boolean) : [];
  if (!files.length) return { success: false, error: 'No files provided' };

  let copied = 0;
  for (const sourcePath of files) {
    if (!fs.existsSync(sourcePath)) continue;
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) continue;

    const fileName = path.basename(sourcePath);
    const destinationPath = path.join(targetPath, fileName);
    fs.copyFileSync(sourcePath, destinationPath);
    copied++;
  }

  return { success: true, count: copied };
});

ipcMain.handle('window-minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
ipcMain.handle('window-maximize-toggle', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('window-close', () => BrowserWindow.getFocusedWindow()?.close());

ipcMain.handle('check-session', () => {
  const session = require('./index.js').checkSession();
  if (session) return { success: true, result: session };
  return { success: false };
});

ipcMain.handle('activate-auth-account', (_, accountId) => {
  try { return { success: true, result: setActiveAuthAccount(accountId) }; }
  catch (error) { return { success: false, error: error?.message || String(error) }; }
});

ipcMain.handle('remove-auth-account', (_, accountId) => {
  try { return { success: true, result: removeAuthAccount(accountId) }; }
  catch (error) { return { success: false, error: error?.message || String(error) }; }
});

ipcMain.handle('login-offline', async (_, username) => {
  try { return { success: true, result: await require('./index.js').loginOffline(username) }; }
  catch (error) { return { success: false, error: error?.message }; }
});