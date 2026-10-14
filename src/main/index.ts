import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  session,
  type IpcMainInvokeEvent,
} from 'electron';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  knowledgeSchema,
  roleSchema,
  secretUpdateSchema,
  settingsSchema,
  type AppEvent,
  type Knowledge,
  type Match,
  type Result,
  type SessionSummary,
} from '../shared/contracts';
import { parseLegacy } from '../shared/text';
import { Database } from './storage/database';
import { SettingsStore } from './storage/settings';
import { SessionController } from './sessionController';
import { ParaformerAdapter } from './asr/paraformerAdapter';

app.setName('面试助手');
let window: BrowserWindow;
let db: Database;
let settings: SettingsStore;
let controller: SessionController;
let quitting = false;
let preloadReady = false;
const smoke = process.argv.includes('--smoke-test');
if (smoke || process.argv.includes('--local-data'))
  app.setPath(
    'userData',
    join(app.isPackaged ? dirname(process.execPath) : app.getAppPath(), '.local-data'),
  );
const emit = (event: AppEvent) => {
  if (window && !window.isDestroyed()) window.webContents.send('app:event', event);
};
const validSender = (event: IpcMainInvokeEvent | Electron.IpcMainEvent) =>
  event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
function handle(name: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(name, async (event, ...args): Promise<Result<unknown>> => {
    if (!validSender(event)) return { ok: false, error: '无效的应用请求' };
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      const error =
        e instanceof z.ZodError
          ? (e.issues[0]?.message ?? '输入格式无效')
          : e instanceof Error
            ? e.message
            : '操作失败';
      return { ok: false, error };
    }
  });
}
function saveDialog(defaultPath: string, filters: Electron.FileFilter[]) {
  return dialog.showSaveDialog(window, { defaultPath, filters });
}
function applyWindowSettings() {
  const s = settings.public().settings;
  window.setAlwaysOnTop(s.alwaysOnTop);
  window.setContentProtection(s.contentProtection);
}
function setupIpc() {
  handle('settings:get', () => {
    preloadReady = true;
    return settings.public();
  });
  handle('settings:save', (value, secrets) => {
    const result = settings.save(settingsSchema.parse(value), secretUpdateSchema.parse(secrets));
    applyWindowSettings();
    return result;
  });
  handle('provider:test', async (rawKind, rawSettings, rawKey) => {
    const kind = z.enum(['asr', 'llm']).parse(rawKind);
    const s = settingsSchema.parse(rawSettings);
    const key = z.string().max(500).optional().parse(rawKey) || settings.key(kind);
    if (!key) throw new Error('请先填写密钥');
    if (kind === 'asr') {
      const adapter = new ParaformerAdapter(
        randomUUID(),
        'interviewer',
        s,
        key,
        () => 0,
        () => {},
        () => {},
      );
      try {
        await adapter.connect();
        return '百炼鉴权和实时识别任务启动成功';
      } finally {
        adapter.stop();
      }
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      const result = await fetch(s.llmEndpoint, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: s.llmModel,
          messages: [{ role: 'user', content: '回复 OK' }],
          thinking: { type: 'disabled' },
          stream: false,
          max_tokens: 8,
        }),
      });
      if (!result.ok)
        throw new Error(`模型测试失败（HTTP ${result.status}），请检查密钥、模型及额度`);
      const body = (await result.json()) as any;
      if (!body.choices?.[0]?.message?.content) throw new Error('接口未返回有效正文');
      return '模型鉴权与正文输出成功';
    } catch (e) {
      if (abort.signal.aborted) throw new Error('模型连接测试超时');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  });
  handle('session:begin', (diagnostic) => controller.begin(z.boolean().parse(diagnostic)));
  handle('session:connect', (id) => controller.connect(z.string().uuid().parse(id)));
  handle('session:stop', () => controller.stop());
  handle('session:clear', () => controller.clear());
  handle('session:answer-latest', () => controller.answerLatest());
  ipcMain.on('audio:frame', (event, value) => {
    if (
      !validSender(event) ||
      !value ||
      typeof value.sessionId !== 'string' ||
      !roleSchema.safeParse(value.role).success ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0
    )
      return;
    if (!(value.pcm instanceof Uint8Array) || value.pcm.byteLength !== 3200) return;
    controller.frame(value);
  });
  handle('audio:ended', (role, reason) =>
    controller.channelEnded(roleSchema.parse(role), z.string().max(200).parse(reason)),
  );
  handle('knowledge:list', () => db.call<Knowledge[]>('list'));
  handle('knowledge:save', (entry) => db.call('upsert', [knowledgeSchema.parse(entry)]));
  handle('knowledge:remove', (id) => db.call('remove', z.string().max(100).parse(id)));
  handle('knowledge:import', async () => {
    const file = await dialog.showOpenDialog(window, {
      filters: [{ name: '题库 JSON / 文本', extensions: ['json', 'txt'] }],
      properties: ['openFile'],
    });
    if (file.canceled) return null;
    const raw = readFileSync(file.filePaths[0], 'utf8');
    if (Buffer.byteLength(raw) > 10_000_000) throw new Error('题库文件不能超过 10 MB');
    let entries: Knowledge[];
    if (file.filePaths[0].toLowerCase().endsWith('.json'))
      entries = z
        .object({ schemaVersion: z.literal(1), entries: z.array(knowledgeSchema).max(5000) })
        .parse(JSON.parse(raw)).entries;
    else
      entries = parseLegacy(raw).map((e) => ({
        ...e,
        id: randomUUID(),
        category: '导入',
        enabled: true,
      }));
    if (entries.length > 5000) throw new Error('单次最多导入 5000 条');
    if (new Set(entries.map((e) => e.id)).size !== entries.length)
      throw new Error('导入文件存在重复 ID');
    await db.call('upsert', entries);
    return entries.length;
  });
  handle('knowledge:export', async () => {
    const file = await saveDialog('面试题库.json', [{ name: 'JSON', extensions: ['json'] }]);
    if (file.canceled || !file.filePath) return null;
    writeFileSync(
      file.filePath,
      JSON.stringify({ schemaVersion: 1, entries: await db.call('list') }, null, 2),
      'utf8',
    );
    return file.filePath;
  });
  handle('sessions:list', () => db.call<SessionSummary[]>('sessions'));
  handle('session:export', async (rawId) => {
    const id = z.string().uuid().parse(rawId);
    const rows = await db.call<{ kind: string; body: any; createdAt: number }[]>('history', id);
    const file = await saveDialog(`面试记录-${new Date().toISOString().slice(0, 10)}.md`, [
      { name: 'Markdown', extensions: ['md'] },
    ]);
    if (file.canceled || !file.filePath) return null;
    const text = rows
      .map((row) => {
        const b = row.body;
        const label =
          row.kind === 'transcript'
            ? b.role === 'candidate'
              ? '面试者'
              : '面试官'
            : row.kind === 'question'
              ? '完整问题'
              : '参考回答';
        return `## ${label} · ${new Date(row.createdAt).toLocaleTimeString('zh-CN')}\n\n${b.text ?? ''}\n\n${row.kind === 'reply' ? `状态：${b.type}；来源：${b.source ?? '未完成'}` : ''}`;
      })
      .join('\n\n');
    writeFileSync(file.filePath, `# 面试会话记录\n\n会话：${id}\n\n${text}\n`, 'utf8');
    return file.filePath;
  });
  handle('diagnostics:export', async () => {
    const file = await saveDialog('腾讯会议-H01-采集诊断.json', [
      { name: '诊断 JSON', extensions: ['json'] },
    ]);
    if (file.canceled || !file.filePath) return null;
    writeFileSync(file.filePath, JSON.stringify(controller.diagnosticReport(), null, 2), 'utf8');
    return file.filePath;
  });
}
app
  .whenReady()
  .then(async () => {
    const directory = app.getPath('userData');
    mkdirSync(directory, { recursive: true });
    settings = new SettingsStore(directory);
    db = new Database(join(directory, 'interviews.sqlite'));
    controller = new SessionController(db, settings, emit);
    window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1080,
      minHeight: 640,
      backgroundColor: '#0a0e16',
      show: !smoke,
      icon: join(app.getAppPath(), 'resources/icon.ico'),
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0c111b', symbolColor: '#cbd5e1', height: 48 },
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    applyWindowSettings();
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        callback(
          contents === window.webContents &&
            (permission === 'display-capture' ||
              (permission === 'media' && !(details as any).mediaTypes?.includes('video'))),
        );
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission) =>
        contents === window.webContents && ['media', 'display-capture'].includes(permission),
    );
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      if (process.platform !== 'win32' || request.frame !== window.webContents.mainFrame) {
        callback({});
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (!sources[0]) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      } catch {
        callback({});
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });
    window.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      quitting = true;
      void Promise.race([
        controller.stop(),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]).finally(() => app.quit());
    });
    setupIpc();
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadFile(join(__dirname, '../renderer/index.html'));
    if (smoke) {
      for (let attempts = 0; attempts < 30 && !preloadReady; attempts++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      if (!preloadReady) throw new Error('预加载接口或页面初始化未通过');
      const entries = await db.call<Knowledge[]>('list');
      const matches = await db.call<Match[]>('search', '缓存一致性');
      const smokeResult = {
        smoke: true,
        platform: process.platform,
        electron: process.versions.electron,
        sqlite: true,
        fts5: true,
        preloadReady,
        rendererLoaded: true,
        entries: entries.length,
        matches: matches.length,
      };
      writeFileSync(join(directory, 'smoke-result.json'), JSON.stringify(smokeResult, null, 2));
      console.log(JSON.stringify(smokeResult));
      quitting = true;
      await db.close();
      app.quit();
    }
  })
  .catch((error) => {
    console.error('应用启动失败：', error instanceof Error ? error.message : '未知错误');
    app.exit(1);
  });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
});
