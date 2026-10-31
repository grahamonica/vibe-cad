type KernelWorker = {
  on(event: "message" | "error" | "exit", listener: (...args: any[]) => void): unknown;
  postMessage(message: any): void;
  terminate(): Promise<number>;
};
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Serialized RPC: OCCT is not reentrant. A poisoned worker must not poison later edits. */
export class KernelWorkerClient {
  private worker?: KernelWorker;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private chain: Promise<void> = Promise.resolve();
  private stopping: Promise<unknown> = Promise.resolve();
  private generation = 0;

  constructor(private createWorker: () => KernelWorker, private timeoutMs = 300_000) {}

  private getWorker() {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    const failed = (error: Error) => {
      if (this.worker !== worker) return;
      void this.close(error).catch(() => {});
    };
    worker.on("message", ({ id, result, error }) => {
      if (this.worker !== worker) return;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      error ? p.reject(Error(error)) : p.resolve(result);
    });
    worker.on("error", (error) => failed(error instanceof Error ? error : Error(String(error))));
    worker.on("exit", () => failed(Error("CAD kernel stopped")));
    return worker;
  }

  private once<T>(method: string, args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const worker = this.getWorker(), id = ++this.sequence;
      const timer = setTimeout(() => {
        void this.close(Error(`CAD kernel exceeded the ${this.timeoutMs / 1000}-second processing limit; the operation was stopped`)).catch(() => {});
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, method, args }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : Error(String(error)));
      }
    });
  }

  call<T>(method: string, args: unknown[]): Promise<T> {
    const generation = this.generation;
    const run = async () => {
      await this.stopping;
      if (generation !== this.generation) throw Error("CAD kernel request was cancelled");
      try { return await this.once<T>(method, args); }
      catch (error) {
        // Retire a damaged native heap. Do not replay an operation or hide its
        // original failure; only a later explicit request starts a new worker.
        if (error instanceof Error && /Expected null or instance of .*got an instance of|memory access out of bounds|null function or function signature mismatch/i.test(error.message))
          await this.close(error);
        throw error;
      } finally { await this.stopping; }
    };
    const result = this.chain.then(run, run);
    this.chain = result.then(() => {}, () => {});
    return result;
  }

  async close(reason = Error("CAD kernel stopped")) {
    this.generation++;
    const worker = this.worker;
    this.worker = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
    if (worker) this.stopping = worker.terminate();
    await this.stopping;
  }
}
