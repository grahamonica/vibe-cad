export class BuildInterrupted extends Error {}
type Revisions = Record<string, number>;
export class BuildControl {
  private active?: {
    documentId?: string; step: number; total: number;
    state: 'running' | 'pausing' | 'paused' | 'stopping';
    wake?: () => void;
  };
  status() { return this.active ? { ...this.active, wake: undefined } : { state: 'idle' as const }; }
  start(documentId: string | undefined, total: number) {
    if (this.active) throw Error('Another build is active; pause or stop it before starting a new batch');
    this.active = { documentId, step: 0, total, state: 'running' };
  }
  control(action: 'status' | 'pause' | 'resume' | 'cancel') {
    const a = this.active;
    if (!a || action === 'status') return this.status();
    if (action === 'pause' && a.state === 'running') a.state = 'pausing';
    if (action === 'cancel') { a.state = 'stopping'; a.wake?.(); }
    if (action === 'resume' && (a.state === 'paused' || a.state === 'pausing')) { a.state = 'running'; a.wake?.(); }
    return this.status();
  }
  async boundary(step: number, documentId: string | undefined, revisions: () => Promise<Revisions>) {
    const a = this.active;
    if (!a) return;
    a.step = step; a.documentId = documentId;
    if (a.state === 'stopping') throw new BuildInterrupted('Build stopped; completed steps were kept');
    if (a.state !== 'pausing') return;
    const before = await revisions();
    const requested = this.status().state;
    if (requested === 'stopping') throw new BuildInterrupted('Build stopped; completed steps were kept');
    if (requested !== 'pausing') return;
    a.state = 'paused';
    await new Promise<void>(resolve => { a.wake = resolve; });
    a.wake = undefined;
    if (this.status().state === 'stopping') throw new BuildInterrupted('Build stopped; completed steps were kept');
    const after = await revisions();
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new BuildInterrupted('The design changed while paused; completed steps and manual edits were kept. Re-plan from the current revision.');
  }
  finish() { this.active?.wake?.(); this.active = undefined; }
}
