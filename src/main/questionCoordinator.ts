import { randomUUID } from 'node:crypto';
import type { Question, Transcript } from '../shared/contracts';
import { isFiller, isQuestion, normalize } from '../shared/text';

export class QuestionCoordinator {
  private draft = new Map<string, Transcript>();
  private consumed = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private lastVoice = 0;
  private lastTextChange = 0;
  private candidateSpoke = false;
  private current?: { question: Question; submittedAt: number; pieces: Map<string, Transcript> };
  private stopped = false;
  private clearBefore = -1;
  constructor(
    private readonly sessionId: string,
    private readonly onReady: (q: Question) => void,
    private readonly onDraft: (text: string) => void = () => {},
  ) {}
  voice(role: 'candidate' | 'interviewer', now = Date.now()) {
    if (this.stopped) return;
    if (role === 'candidate') {
      this.candidateSpoke = true;
      return;
    }
    this.lastVoice = now;
    this.schedule();
  }
  transcript(event: Transcript) {
    if (this.stopped || event.audioStartMs < this.clearBefore) return;
    if (event.role !== 'interviewer') return;
    const was = this.draft.get(event.utteranceId);
    if (was?.isFinal || (was?.text === event.text && was.isFinal === event.isFinal)) return;
    if (this.consumed.has(event.utteranceId)) {
      if (
        event.isFinal &&
        this.current?.question.utteranceIds.includes(event.utteranceId) &&
        this.current.question.provisional
      ) {
        const pending = this.draft;
        this.draft = new Map(this.current.pieces);
        this.draft.set(event.utteranceId, event);
        this.submit(true);
        this.draft = pending;
        this.onDraft(
          this.pieces()
            .map((t) => t.text)
            .join(''),
        );
        this.schedule();
      }
      return;
    }
    this.draft.set(event.utteranceId, event);
    this.lastTextChange = Date.now();
    this.onDraft(
      this.pieces()
        .map((t) => t.text)
        .join(''),
    );
    this.schedule();
  }
  private pieces() {
    return [...this.draft.values()].sort((a, b) => a.audioStartMs - b.audioStartMs);
  }
  private schedule() {
    // Audio frames must not repeatedly postpone the timer: loopback can contain background noise.
    if (this.timer || !this.draft.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.draft.size || this.stopped) return;
      const allFinal = this.pieces().every((t) => t.isFinal);
      const audioQuiet = Date.now() - this.lastVoice;
      const textQuiet = Date.now() - this.lastTextChange;
      // ASR final/stable text is a second endpoint signal when energy never falls below VAD.
      if (audioQuiet < (allFinal ? 600 : 900) && textQuiet < (allFinal ? 1000 : 1600)) {
        this.schedule();
        return;
      }
      this.submit(false);
    }, 100);
  }
  private submit(correction: boolean, force = false) {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pieces = this.pieces();
    const text = pieces.map((t) => t.text).join('');
    const ids = pieces.map((t) => t.utteranceId);
    this.draft.clear();
    this.onDraft('');
    ids.forEach((id) => this.consumed.add(id));
    const previous = this.current;
    const merge =
      correction ||
      (!force &&
        !isQuestion(text) &&
        !!previous &&
        Date.now() - previous.submittedAt <= 1500 &&
        !this.candidateSpoke);
    if (isFiller(text) || (!force && !isQuestion(text) && !merge)) return;
    const combinedPieces =
      merge && previous ? new Map(previous.pieces) : new Map<string, Transcript>();
    pieces.forEach((piece) => combinedPieces.set(piece.utteranceId, piece));
    const provisional = [...combinedPieces.values()].some((t) => !t.isFinal);
    const combined = [...combinedPieces.values()]
      .sort((a, b) => a.audioStartMs - b.audioStartMs)
      .map((t) => t.text)
      .join('');
    if (merge && previous && normalize(combined) === normalize(previous.question.text)) {
      this.current = {
        ...previous,
        pieces: combinedPieces,
        question: { ...previous.question, provisional },
      };
      return;
    }
    const question: Question = {
      sessionId: this.sessionId,
      questionId: merge && previous ? previous.question.questionId : randomUUID(),
      revision: merge && previous ? previous.question.revision + 1 : 1,
      text: combined,
      utteranceIds:
        merge && previous ? [...new Set([...previous.question.utteranceIds, ...ids])] : ids,
      provisional,
    };
    this.current = { question, submittedAt: Date.now(), pieces: combinedPieces };
    this.candidateSpoke = false;
    this.onReady(question);
  }
  answerLatest() {
    if (this.stopped) return false;
    if (this.draft.size) {
      if (
        isFiller(
          this.pieces()
            .map((t) => t.text)
            .join(''),
        )
      )
        return false;
      this.submit(false, true);
      return true;
    }
    if (!this.current) return false;
    this.current.question = {
      ...this.current.question,
      revision: this.current.question.revision + 1,
    };
    this.onReady(this.current.question);
    return true;
  }
  clear(audioTimeMs: number) {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.draft.clear();
    this.consumed.clear();
    this.current = undefined;
    this.candidateSpoke = false;
    this.clearBefore = audioTimeMs;
    this.onDraft('');
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.draft.clear();
    this.onDraft('');
  }
}
