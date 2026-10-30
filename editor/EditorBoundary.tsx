import { Component, type ReactNode } from 'react';

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
      <button className="primary" onClick={() => window.location.reload()}>Reload editor</button>
    </main>;
  }
}
