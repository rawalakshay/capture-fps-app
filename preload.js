'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  tools: () => ipcRenderer.invoke('tools'),
  version: () => ipcRenderer.invoke('version'),
  pickVideo: () => ipcRenderer.invoke('pick-video'),
  pickFolder: (current) => ipcRenderer.invoke('pick-folder', current),
  probe: (video) => ipcRenderer.invoke('probe', video),
  isVideo: (p) => ipcRenderer.invoke('is-video', p),
  gpu: () => ipcRenderer.invoke('gpu'),
  vulkan: () => ipcRenderer.invoke('vulkan'),
  startJob: (opts) => ipcRenderer.invoke('start-job', opts),
  renderOnly: (opts) => ipcRenderer.invoke('render-only', opts),
  preview: (opts, at) => ipcRenderer.invoke('preview', opts, at),
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
