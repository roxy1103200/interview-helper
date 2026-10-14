import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
export class Database {
  private worker: Worker;
  private sequence = 0;
  private failed = false;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(path: string) {
    this.worker = new Worker(join(__dirname, 'db.worker.js'), { workerData: { path } });
    this.worker.on('message', ({ id, result, error }) => {
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (error) p?.reject(new Error(error));
      else p?.resolve(result);
    });
    const fail = () => {
      this.failed = true;
      for (const p of this.pending.values()) p.reject(new Error('本地数据库进程已停止'));
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', fail);
  }
  call<T = void>(op: string, ...args: unknown[]): Promise<T> {
    if (this.failed) return Promise.reject(new Error('本地数据库进程已停止'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, args });
    });
  }
  async close() {
    await this.call('close');
    await this.worker.terminate();
  }
}
