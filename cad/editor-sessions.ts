/** Live editor leases only. No geometry, drafts or persistent document data. */
export class EditorSessions {
  private sessions = new Map<string, { sessionId: string; documentId: string; touched: number; dirty: boolean; closed: boolean }>();
  readonly limit = 5;
  constructor(private now = () => Date.now()) {}
  private sweep() {
    for (const [id, s] of this.sessions) if (this.now() - s.touched > 90_000) this.sessions.delete(id);
    while (this.sessions.size > 32) {
      const retired = [...this.sessions.values()].find(s => s.closed);
      if (!retired) break;
      this.sessions.delete(retired.sessionId);
    }
  }
  update(action: 'list' | 'register' | 'heartbeat' | 'close' | 'close_others', sessionId?: string, documentId?: string, dirty = false) {
    this.sweep();
    if (action === 'register') {
      if (!sessionId || !documentId) throw Error('Register needs sessionId and documentId');
      for (const s of this.sessions.values()) if (s.documentId === documentId && s.sessionId !== sessionId && !s.dirty) s.closed = true;
      const active = [...this.sessions.values()].filter(s => !s.closed && s.sessionId !== sessionId).sort((a,b) => a.touched - b.touched);
      const available = active.find(s => !s.dirty);
      const denied = active.length >= this.limit && !available;
      if (!denied && active.length >= this.limit) available!.closed = true;
      this.sessions.set(sessionId, {sessionId, documentId, touched: this.now(), dirty, closed: denied});
    }
    const current = sessionId && this.sessions.get(sessionId);
    if (action === 'heartbeat' && current) { current.touched = this.now(); current.dirty = dirty; }
    if (action === 'close' && current) {
      if (current.dirty) throw Error('Finish or cancel unsaved edits before closing this editor');
      current.closed = true;
    }
    if (action === 'close_others') for (const s of this.sessions.values())
      if (s.sessionId !== sessionId && s.documentId !== documentId && !s.dirty) s.closed = true;
    this.sweep();
    return {limit: this.limit, sessionId, closeRequested: action === 'heartbeat' && !current || !!current && current.closed,
      editors: [...this.sessions.values()].map(s => ({...s})),
      protectedDrafts: [...this.sessions.values()].filter(s => !s.closed && s.dirty).length};
  }
}
