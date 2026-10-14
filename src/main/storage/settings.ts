import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultSettings,
  settingsSchema,
  type PublicSettings,
  type Settings,
  type Secrets,
} from '../../shared/contracts';
export class SettingsStore {
  private settings: Settings = { ...defaultSettings };
  private encrypted: Partial<Secrets> = {};
  private volatile: Partial<Secrets> = {};
  private path: string;
  constructor(directory: string) {
    this.path = join(directory, 'settings.json');
    if (existsSync(this.path)) {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      this.settings = settingsSchema.parse({ ...defaultSettings, ...parsed.settings });
      this.encrypted = parsed.secrets ?? {};
    }
  }
  key(kind: keyof Secrets) {
    if (this.volatile[kind]) return this.volatile[kind]!;
    try {
      return this.encrypted[kind]
        ? safeStorage.decryptString(Buffer.from(this.encrypted[kind]!, 'base64'))
        : '';
    } catch {
      return '';
    }
  }
  public(): PublicSettings {
    return {
      settings: { ...this.settings },
      hasAsrKey: !!this.key('asr'),
      hasLlmKey: !!this.key('llm'),
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    };
  }
  save(settings: Settings, update: Partial<Secrets>): PublicSettings {
    const next = settingsSchema.parse(settings);
    const encrypted = { ...this.encrypted };
    const volatile = { ...this.volatile };
    for (const kind of ['asr', 'llm'] as const) {
      if (update[kind] === undefined) continue;
      delete encrypted[kind];
      delete volatile[kind];
      const key = update[kind]!.trim();
      if (key) {
        if (safeStorage.isEncryptionAvailable())
          encrypted[kind] = safeStorage.encryptString(key).toString('base64');
        else volatile[kind] = key;
      }
    }
    writeFileSync(
      this.path + '.tmp',
      JSON.stringify({ schemaVersion: 1, settings: next, secrets: encrypted }, null, 2),
      'utf8',
    );
    renameSync(this.path + '.tmp', this.path);
    this.settings = next;
    this.encrypted = encrypted;
    this.volatile = volatile;
    return this.public();
  }
}
