import { z } from 'zod';

export const roleSchema = z.enum(['candidate', 'interviewer']);
export type AudioRole = z.infer<typeof roleSchema>;
export type Status =
  'idle' | 'starting' | 'listening' | 'degraded' | 'stopping' | 'stopped' | 'error';
export const settingsSchema = z.object({
  micDeviceId: z.string().max(500).default(''),
  asrEndpoint: z
    .string()
    .url()
    .refine((v) => {
      const u = new URL(v);
      return (
        u.protocol === 'wss:' &&
        (u.hostname === 'dashscope.aliyuncs.com' || u.hostname.endsWith('.maas.aliyuncs.com')) &&
        !u.username &&
        !u.password &&
        !u.search
      );
    }, '请使用百炼官方 WSS 地址'),
  asrModel: z.literal('paraformer-realtime-v2'),
  llmEndpoint: z
    .string()
    .url()
    .refine((v) => {
      const u = new URL(v);
      return (
        u.protocol === 'https:' && u.hostname === 'api.deepseek.com' && !u.username && !u.password
      );
    }, '首版仅支持 DeepSeek 官方 HTTPS 接口'),
  llmModel: z.string().trim().min(1).max(120),
  resume: z.string().max(16000).default(''),
  fontSize: z.number().min(13).max(24).default(16.5),
  alwaysOnTop: z.boolean().default(false),
  contentProtection: z.boolean().default(false),
  recordText: z.boolean().default(true),
  vadThreshold: z.number().min(0.002).max(0.1).default(0.008),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  micDeviceId: '',
  asrEndpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  asrModel: 'paraformer-realtime-v2',
  llmEndpoint: 'https://api.deepseek.com/chat/completions',
  llmModel: 'deepseek-flash',
  resume: '',
  fontSize: 16.5,
  alwaysOnTop: false,
  contentProtection: false,
  recordText: true,
  vadThreshold: 0.008,
};
export const secretUpdateSchema = z.object({
  asr: z.string().max(500).optional(),
  llm: z.string().max(500).optional(),
});
export type Secrets = { asr: string; llm: string };
export type PublicSettings = {
  settings: Settings;
  hasAsrKey: boolean;
  hasLlmKey: boolean;
  encryptionAvailable: boolean;
};
export const knowledgeSchema = z.object({
  id: z.string().min(1).max(100),
  category: z.string().max(100),
  title: z.string().min(1).max(300),
  keywords: z.array(z.string().min(1).max(100)).max(100),
  answer: z.string().min(1).max(30000),
  enabled: z.boolean(),
});
export type Knowledge = z.infer<typeof knowledgeSchema>;
export type Match = Knowledge & { score: number; direct: boolean };
export interface Transcript {
  sessionId: string;
  role: AudioRole;
  utteranceId: string;
  generation: number;
  text: string;
  isFinal: boolean;
  audioStartMs: number;
  audioEndMs?: number;
  receivedAt: number;
}
export interface Question {
  sessionId: string;
  questionId: string;
  revision: number;
  text: string;
  utteranceIds: string[];
  provisional: boolean;
}
export interface Reply {
  sessionId: string;
  epoch: number;
  requestId: string;
  questionId: string;
  revision: number;
  type: 'start' | 'progress' | 'delta' | 'reference' | 'complete' | 'cancelled' | 'error';
  text?: string;
  source?: 'knowledge' | 'llm';
  message?: string;
}
export interface AudioStats {
  role: AudioRole;
  frames: number;
  rms: number;
  peak: number;
  lastFrameAt: number;
  speaking: boolean;
}
export type AppEvent =
  | { type: 'status'; status: Status; message: string; sessionId: string | null; epoch: number }
  | { type: 'channel'; role: AudioRole; connected: boolean; message: string }
  | { type: 'transcript'; data: Transcript }
  | { type: 'question'; data: Question }
  | { type: 'question-draft'; sessionId: string; epoch: number; text: string }
  | { type: 'reply'; data: Reply }
  | { type: 'audio'; data: AudioStats }
  | { type: 'notice'; message: string };
export interface SessionSummary {
  id: string;
  startedAt: number;
  endedAt: number | null;
  status: string;
}
export interface Frame {
  sessionId: string;
  role: AudioRole;
  sequence: number;
  pcm: Uint8Array;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface Api {
  getSettings(): Promise<PublicSettings>;
  saveSettings(value: Settings, secrets: Partial<Secrets>): Promise<PublicSettings>;
  testProvider(kind: 'asr' | 'llm', settings: Settings, key?: string): Promise<string>;
  begin(diagnostic: boolean): Promise<{ sessionId: string; epoch: number }>;
  connect(sessionId: string): Promise<void>;
  stop(): Promise<void>;
  clear(): Promise<{ epoch: number }>;
  answerLatest(): Promise<void>;
  frame(frame: Frame): void;
  channelEnded(role: AudioRole, message: string): void;
  listKnowledge(): Promise<Knowledge[]>;
  saveKnowledge(entry: Knowledge): Promise<void>;
  removeKnowledge(id: string): Promise<void>;
  importKnowledge(): Promise<number | null>;
  exportKnowledge(): Promise<string | null>;
  sessions(): Promise<SessionSummary[]>;
  exportSession(id: string): Promise<string | null>;
  exportDiagnostics(): Promise<string | null>;
  subscribe(fn: (event: AppEvent) => void): () => void;
}
