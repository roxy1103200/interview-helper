import { create } from 'zustand';
import type {
  AppEvent,
  AudioRole,
  AudioStats,
  Question,
  Status,
  Transcript,
} from '../../../shared/contracts';
export interface Answer {
  requestId: string;
  question: string;
  questionId: string;
  revision: number;
  text: string;
  reference: string;
  source?: string;
  status: string;
  message?: string;
  progress: string;
}
interface State {
  status: Status;
  message: string;
  sessionId: string | null;
  epoch: number;
  transcripts: Record<AudioRole, Transcript[]>;
  interim: Partial<Record<AudioRole, Transcript>>;
  stats: Partial<Record<AudioRole, AudioStats>>;
  channels: Partial<Record<AudioRole, string>>;
  questions: Question[];
  questionDraft: string;
  answers: Answer[];
  notice: string;
  clearedAt: number;
  event: (e: AppEvent) => void;
  clear: (epoch: number) => void;
}
export const useSessionStore = create<State>((set, get) => ({
  status: 'idle',
  message: '待开始',
  sessionId: null,
  epoch: 0,
  transcripts: { candidate: [], interviewer: [] },
  interim: {},
  stats: {},
  channels: {},
  questions: [],
  questionDraft: '',
  answers: [],
  notice: '',
  clearedAt: 0,
  event: (e) => {
    if (e.type === 'status') {
      if (e.epoch < get().epoch) return;
      if (e.status === 'starting' && e.sessionId !== get().sessionId)
        set({
          transcripts: { candidate: [], interviewer: [] },
          interim: {},
          answers: [],
          questions: [],
          questionDraft: '',
          stats: {},
          channels: {},
          notice: '',
        });
      set({ status: e.status, message: e.message, sessionId: e.sessionId, epoch: e.epoch });
    } else if (e.type === 'notice') set({ notice: e.message });
    else if (e.type === 'audio') set((s) => ({ stats: { ...s.stats, [e.data.role]: e.data } }));
    else if (e.type === 'channel')
      set((s) => ({ channels: { ...s.channels, [e.role]: e.message } }));
    else if (e.type === 'transcript') {
      const t = e.data;
      if (t.sessionId !== get().sessionId || t.receivedAt <= get().clearedAt) return;
      set((s) =>
        t.isFinal
          ? {
              transcripts: {
                ...s.transcripts,
                [t.role]: [
                  ...s.transcripts[t.role].filter((x) => x.utteranceId !== t.utteranceId),
                  t,
                ].slice(-300),
              },
              interim: { ...s.interim, [t.role]: undefined },
            }
          : { interim: { ...s.interim, [t.role]: t } },
      );
    } else if (e.type === 'question-draft') {
      if (e.sessionId === get().sessionId && e.epoch === get().epoch)
        set({ questionDraft: e.text });
    } else if (e.type === 'question')
      set((s) => ({
        questions: [...s.questions.filter((q) => q.questionId !== e.data.questionId), e.data].slice(
          -100,
        ),
      }));
    else if (e.type === 'reply') {
      const r = e.data;
      if (r.sessionId !== get().sessionId || r.epoch !== get().epoch) return;
      set((s) => {
        if (r.type === 'start')
          return {
            answers: [
              ...s.answers.filter((a) => a.questionId !== r.questionId),
              {
                requestId: r.requestId,
                questionId: r.questionId,
                revision: r.revision,
                question: s.questions.find((q) => q.questionId === r.questionId)?.text ?? '',
                text: '',
                reference: '',
                status: 'generating',
                progress: r.message ?? '正在准备回答',
              },
            ].slice(-100),
          };
        return {
          answers: s.answers.map((a) =>
            a.requestId === r.requestId
              ? {
                  ...a,
                  text: r.type === 'delta' ? a.text + (r.text ?? '') : a.text,
                  reference: r.type === 'reference' ? (r.text ?? '') : a.reference,
                  source: r.type === 'reference' ? a.source : (r.source ?? a.source),
                  status: ['complete', 'cancelled', 'error'].includes(r.type) ? r.type : a.status,
                  message: r.type === 'error' ? r.message : a.message,
                  progress: r.type === 'progress' ? (r.message ?? a.progress) : a.progress,
                }
              : a,
          ),
        };
      });
    }
  },
  clear: (epoch) =>
    set({
      epoch,
      clearedAt: Date.now(),
      transcripts: { candidate: [], interviewer: [] },
      interim: {},
      questions: [],
      questionDraft: '',
      answers: [],
      notice: '',
    }),
}));
