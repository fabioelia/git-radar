// Unwraps the {ok, data|error} envelopes from main into values/exceptions.

const raw = window.gitRadar;

async function call(fn, ...args) {
  const res = await fn(...args);
  if (!res || res.ok !== true) throw new Error(res?.error || 'IPC call failed');
  return res.data;
}

export const api = {
  appInfo: () => call(raw.appInfo),
  settingsGet: () => call(raw.settingsGet),
  settingsSave: (s) => call(raw.settingsSave, s),
  healthCheck: () => call(raw.healthCheck),
  ollamaModels: () => call(raw.ollamaModels),
  mcpTest: (server) => call(raw.mcpTest, server),

  reposList: () => call(raw.reposList),
  repoSave: (repo) => call(raw.repoSave, repo),
  repoDelete: (id) => call(raw.repoDelete, id),
  sprintCreate: (repoId, opts) => call(raw.sprintCreate, repoId, opts),
  sprintData: (sprintId) => call(raw.sprintData, sprintId),

  sprintScan: (id) => call(raw.sprintScan, id),
  sprintSync: (id) => call(raw.sprintSync, id),
  sprintCategorize: (id, opts) => call(raw.sprintCategorize, id, opts),
  sprintReorganize: (id) => call(raw.sprintReorganize, id),
  sprintReport: (id) => call(raw.sprintReport, id),

  bucketRename: (sprintId, bucketId, name) => call(raw.bucketRename, sprintId, bucketId, name),
  prMove: (sprintId, prNumber, bucketId) => call(raw.prMove, sprintId, prNumber, bucketId),

  onProgress: (cb) => raw.onProgress(cb),
};
