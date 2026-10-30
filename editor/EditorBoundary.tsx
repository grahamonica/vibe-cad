import { Component, type ReactNode } from 'react';
import {editorRecovery} from '../cad/editor-recovery.ts';
import {reloadEditor} from './bridge.ts';

/** React errors get a recovery action; a host renderer crash must be recovered by the host. */
export class EditorBoundary extends Component<{children: ReactNode}, {error: string}> {
  state = {error: ''};
  static getDerivedStateFromError(error: unknown) {
    return {error: error instanceof Error ? error.message : 'The editor could not display this view.'};
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="editor-recovery" role="alert">
      <h1>The editor paused</h1>
      <p>Your saved documents are unchanged.</p>
      <p>{this.state.error}</p>
      <p>Reopening restores the saved design. Unfinished edits in this view may be lost.</p>
      <button className="primary" onClick={() => void reloadEditor(true)}>Reopen saved design</button>
      <details><summary>If the view crashes again</summary><ol>{editorRecovery.map(step=><li key={step}>{step}</li>)}</ol></details>
    </main>;
  }
}
