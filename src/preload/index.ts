import { contextBridge, ipcRenderer } from 'electron';
import type { Api, AppEvent, Result } from '../shared/contracts';
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const api: Api = {
  getSettings: () => invoke('settings:get'),
  saveSettings: (s, keys) => invoke('settings:save', s, keys),
  testProvider: (kind, s, key) => invoke('provider:test', kind, s, key),
  begin: (diagnostic) => invoke('session:begin', diagnostic),
  connect: (id) => invoke('session:connect', id),
  stop: () => invoke('session:stop'),
  clear: () => invoke('session:clear'),
  answerLatest: () => invoke('session:answer-latest'),
  frame: (frame) => ipcRenderer.send('audio:frame', frame),
  channelEnded: (role, reason) => {
    void invoke('audio:ended', role, reason);
  },
  listKnowledge: () => invoke('knowledge:list'),
  saveKnowledge: (e) => invoke('knowledge:save', e),
  removeKnowledge: (id) => invoke('knowledge:remove', id),
  importKnowledge: () => invoke('knowledge:import'),
  exportKnowledge: () => invoke('knowledge:export'),
  sessions: () => invoke('sessions:list'),
  exportSession: (id) => invoke('session:export', id),
  exportDiagnostics: () => invoke('diagnostics:export'),
  subscribe: (fn) => {
    const listener = (_event: unknown, value: AppEvent) => fn(value);
    ipcRenderer.on('app:event', listener);
    return () => ipcRenderer.removeListener('app:event', listener);
  },
};
contextBridge.exposeInMainWorld('interviewApi', api);
