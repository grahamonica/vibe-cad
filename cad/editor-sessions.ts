import {editorRecovery} from './editor-recovery.ts';
/** Renderer heartbeats are not proof that a host tab has closed. */
export class EditorSessions {
  private sessions = new Map<string, { sessionId: string; documentId: string; touched: number; dirty: boolean; closeRequested: boolean; hostClosed:boolean; rendererRetired:boolean; reloadRequested:boolean }>();
  readonly limit = 5;
  constructor(private now = () => Date.now()) {}
  private sweep() {
    while (this.sessions.size > 32) {
      const retired = [...this.sessions.values()].find(s => s.hostClosed);
      if (!retired) break;
      this.sessions.delete(retired.sessionId);
    }
  }
  update(action: 'list' | 'register' | 'heartbeat' | 'close' | 'close_others' | 'reload' | 'retire' | 'teardown_ack'|'forget'|'resume', sessionId?: string, documentId?: string, dirty = false,confirmHostClosed=false) {
    this.sweep();
    if (action === 'register') {
      if (!sessionId || !documentId) throw Error('Register needs sessionId and documentId');
      // A historical, unresponsive lease is not a live renderer. Keep it visible
      // without letting missing host acknowledgements permanently prevent reopening.
      const occupied = [...this.sessions.values()].filter(s => !s.hostClosed && !s.rendererRetired && this.now()-s.touched<=90_000 && s.sessionId !== sessionId).sort((a,b) => a.touched - b.touched);
      for (const s of this.sessions.values()) if (s.documentId === documentId && s.sessionId !== sessionId && !s.dirty&&!s.hostClosed) s.closeRequested = true;
      const denied = occupied.length >= this.limit;
      if(denied){const saved=occupied.find(s=>!s.dirty);if(saved)saved.closeRequested=true;}
      // Never hide a crashed/pending tab by expiring its lease, or overwrite another document's live session.
      const previous=this.sessions.get(sessionId);
      if(previous&&previous.documentId!==documentId&&!previous.hostClosed&&previous.dirty)throw Error('Finish or cancel unsaved edits before switching documents');
      this.sessions.set(sessionId, {sessionId, documentId, touched: this.now(), dirty, closeRequested: denied,hostClosed:false,rendererRetired:false,reloadRequested:false});
    }
    const current = sessionId ? this.sessions.get(sessionId):undefined;
    if(action==='forget'){
      if(!sessionId||!confirmHostClosed)throw Error('Forget requires a sessionId and confirmation that the user closed that host tab with ×. It does not close a tab.');
      this.sessions.delete(sessionId);
    }
    if (action === 'heartbeat' && current) { current.touched = this.now(); current.dirty = dirty; }
    if(action==='close'||action==='reload'){
      if(!sessionId&&!documentId)throw Error('Choose a sessionId or documentId');
      const targets=[...this.sessions.values()].filter(s=>sessionId?s.sessionId===sessionId:s.documentId===documentId).filter(s=>!s.hostClosed);
      if(targets.some(s=>s.dirty))throw Error('Finish or cancel unsaved edits before closing or reloading this editor');
      for(const s of targets)if(action==='close'){s.closeRequested=true;s.reloadRequested=false;}else if(!s.closeRequested)s.reloadRequested=true;
    }
    if(action==='teardown_ack'&&current){current.hostClosed=true;current.reloadRequested=false;}
    if(action==='retire'&&current){if(current.dirty)throw Error('Finish or cancel unsaved edits before retiring this editor');current.rendererRetired=true;current.reloadRequested=false;}
    if (action === 'close_others') for (const s of this.sessions.values())
      if (s.sessionId !== sessionId && s.documentId !== documentId && !s.dirty&&!s.hostClosed) {s.closeRequested = true;s.reloadRequested=false;}
    this.sweep();
    const editors=[...this.sessions.values()].map(s=>({...s,closed:s.hostClosed,status:s.hostClosed?'host_closed':s.rendererRetired?'renderer_retired':this.now()-s.touched>90_000?'unresponsive':s.closeRequested?'close_requested':s.reloadRequested?'reload_requested':'active'}));
    return {limit: this.limit, sessionId,resumeDocumentId:action==='resume'&&current&&!current.hostClosed&&!current.closeRequested?current.documentId:undefined,registerRequired:action==='heartbeat'&&!current,closeRequested:!!current && (current.closeRequested||current.hostClosed),reloadRequested:!!current?.reloadRequested,
      editors,deadPanelControl:'host-only',recoveryInstructions:editorRecovery,
      hostActionRequired:editors.some(s=>s.status==='unresponsive'),
      protectedDrafts: [...this.sessions.values()].filter(s => !s.hostClosed && s.dirty).length};
  }
}
