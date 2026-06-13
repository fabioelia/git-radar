import path from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { initStore } from './services/store.js';
import { disconnectAll } from './services/mcp.js';
import { registerIpc } from './ipc.js';

const here = import.meta.dirname;
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0e1116',
    title: 'Git Radar',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links (PR urls etc.) open in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (/^https?:\/\//i.test(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.loadFile(path.join(here, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  initStore(process.env.GIT_RADAR_DATA_DIR || app.getPath('userData'));
  registerIpc(() => mainWindow, {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  disconnectAll().catch(() => {});
});
