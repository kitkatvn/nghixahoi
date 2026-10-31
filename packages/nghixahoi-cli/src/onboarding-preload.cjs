const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('nghixahoiOnboarding', {
  selectFolders() {
    return ipcRenderer.invoke('nghixahoi:onboarding-select-folders');
  },
  submit(input) {
    return ipcRenderer.invoke('nghixahoi:onboarding-submit', input);
  },
  removeProject(projectId) {
    return ipcRenderer.invoke('nghixahoi:onboarding-remove-project', projectId);
  },
  initialState() {
    return ipcRenderer.invoke('nghixahoi:onboarding-initial-state');
  },
  close() {
    return ipcRenderer.invoke('nghixahoi:onboarding-close');
  },
});
