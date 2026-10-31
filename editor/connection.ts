/** One connection state for every backend request, including background polls.
 * A closed transport requires host reconnection; repeating requests cannot fix it.
 * Ordinary tool/validation errors do not disconnect a healthy session.
 */
export class CadConnection {
  private failure?: Error;
  constructor(private readonly disconnected: (error: Error) => void) {}
  get active() { return !this.failure; }
  async request<T>(invoke: () => Promise<T>): Promise<T> {
    if (this.failure) throw this.failure;
    try { return await invoke(); }
    catch (error) {
      if (error instanceof Error && /(?:transport|connection).*clos(?:ed|ure)|not connected/i.test(error.message)) {
        if (!this.failure) {
          this.failure = Error('Connection to CAD tools was closed. Saved documents remain on disk. Close this editor tab, restart Codex, and reopen the saved design.');
          this.disconnected(this.failure);
        }
        throw this.failure;
      }
      throw error;
    }
  }
}
