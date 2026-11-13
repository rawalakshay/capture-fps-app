'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  tools: () => ipcRenderer.invoke('tools'),
  version: () => ipcRenderer.invoke('version'),
  pickVideo: () => ipcRenderer.invoke('pick-video'),
  pickFolder: (current) => ipcRenderer.invoke('pick-folder', current),
  probe: (video) => ipcRenderer.invoke('probe', video),
  gpu: () => ipcRenderer.invoke('gpu'),
  vulkan: () => ipcRenderer.invoke('vulkan'),
  startJob: (opts) => ipcRenderer.invoke('start-job', opts),
  renderOnly: (opts) => ipcRenderer.invoke('render-only', opts),
  preview: (opts, at) => ipcRenderer.invoke('preview', opts, at),
  compare: (opts) => ipcRenderer.invoke('compare', opts),
  loadResult: (outDir) => ipcRenderer.invoke('load-result', outDir),
  abData: (outDir) => ipcRenderer.invoke('ab-data', outDir),
  abSummary: (outDir, skip, span) => ipcRenderer.invoke('ab-summary', outDir, skip, span),
  abVerdict:(sumA, sumB, titles) => ipcRenderer.invoke('ab-verdict', sumA, sumB, titles),
  frameAt: (video, t) => ipcRenderer.invoke('frame-at', video, t),
  compareAB: (opts) => ipcRenderer.invoke('compare-ab', opts),
  projectData: (project) => ipcRenderer.invoke('project-data', project),
  timelineFrame: (project, t) => ipcRenderer.invoke('timeline-frame', project, t),
  renderTimeline: (project) => ipcRenderer.invoke('render-timeline', project),
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
