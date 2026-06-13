// Sandboxed bridge: a fixed method map (no open invoke channel) so the
// renderer can only reach the IPC surface we define.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('gitRadar', {
  appInfo: invoke('app:info'),
  settingsGet: invoke('settings:get'),
  settingsSave: invoke('settings:save'),
  healthCheck: invoke('health:check'),
  ollamaModels: invoke('ollama:models'),
  mcpTest: invoke('mcp:test'),

  reposList: invoke('repos:list'),
  repoSave: invoke('repo:save'),
  repoDelete: invoke('repo:delete'),
  sprintCreate: invoke('sprint:create'),
  sprintData: invoke('sprint:data'),

  sprintScan: invoke('sprint:scan'),
  sprintSync: invoke('sprint:sync'),
  sprintCategorize: invoke('sprint:categorize'),
  sprintReorganize: invoke('sprint:reorganize'),
  sprintReport: invoke('sprint:report'),

  bucketRename: invoke('bucket:rename'),
  prMove: invoke('pr:move'),

  onProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    ipcRenderer.on('grx:progress', listener);
    return () => ipcRenderer.removeListener('grx:progress', listener);
  },
});
