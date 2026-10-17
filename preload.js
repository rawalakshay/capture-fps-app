'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  tools: () => ipcRenderer.invoke('tools'),
  pickVideo: () => ipcRenderer.invoke('pick-video'),
  pickFolder: (current) => ipcRenderer.invoke('pick-folder', current),
  probe: (video) => ipcRenderer.invoke('probe', video),
  isVideo: (p) => ipcRenderer.invoke('is-video', p),
  gpu: () => ipcRenderer.invoke('gpu'),
  startJob: (opts) => ipcRenderer.invoke('start-job', opts),
  renderOnly: (opts) => ipcRenderer.invoke('render-only', opts),
  cancelJob: () => ipcRenderer.invoke('cancel-job'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('job-progress', handler);
    return () => ipcRenderer.removeListener('job-progress', handler);
  },
});
