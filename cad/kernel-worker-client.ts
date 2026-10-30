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
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private createWorker: () => KernelWorker, private timeoutMs = 120_000) {}

  private getWorker() {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    const failed = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
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
        this.pending.delete(id);
        if (this.worker === worker) this.worker = undefined;
        void worker.terminate();
        reject(Error(`CAD kernel exceeded ${this.timeoutMs / 1000} seconds; retry with a simpler model or a STEP file instead of a dense STL`));
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
    const run = async () => {
      try { return await this.once<T>(method, args); }
      catch (error) {
        // These are WASM/Embind lifetime failures, not invalid user geometry.
        // Rebuild once in a fresh worker, preserving normal validation errors.
        if (!(error instanceof Error) || !/Expected null or instance of .*got an instance of|memory access out of bounds|null function or function signature mismatch/i.test(error.message)) throw error;
        await this.close();
        return this.once<T>(method, args);
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  async close() {
    const worker = this.worker;
    this.worker = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("CAD kernel stopped"));
    }
    this.pending.clear();
    await worker?.terminate();
  }
}
