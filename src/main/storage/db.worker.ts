import { parentPort, workerData } from 'node:worker_threads';
import { Store } from './store';
const store = new Store(workerData.path);
parentPort!.on('message', ({ id, op, args }: { id: number; op: keyof Store; args: unknown[] }) => {
  try {
    const method = store[op];
    if (typeof method !== 'function') throw new Error('无效的数据操作');
    const result = (method as (...args: unknown[]) => unknown).apply(store, args);
    parentPort!.postMessage({ id, result });
  } catch {
    parentPort!.postMessage({ id, error: '本地数据库操作失败，请检查数据目录权限或导入格式' });
  }
});
