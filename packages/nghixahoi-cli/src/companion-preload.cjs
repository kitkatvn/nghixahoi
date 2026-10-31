const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('nghixahoiCompanion', {
  hide() {
    return ipcRenderer.invoke('nghixahoi:companion-hide');
  },
  openDashboard() {
    return ipcRenderer.invoke('nghixahoi:open-dashboard');
  },
});
