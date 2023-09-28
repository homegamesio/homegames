const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronApi', {
    ayy: (lmao) => ipcRenderer.send('ayy', lmao),
    onUpdate: (e) => ipcRenderer.on('update', e),
    onReady: (e) => ipcRenderer.on('ready', e)
});
