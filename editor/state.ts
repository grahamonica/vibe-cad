// Document state, serialized command execution and external-change polling.
import { useEffect, useRef, useState } from "react";
import type { View } from "../cad/types.ts";
import {
  call,
  context,
  initialize,
  onView,
  onTransfer,
  type ViewTransfer,
} from "./bridge.ts";

/** Tools that do not take an expectedRevision. */
const unrevised = new Set([
  "list_documents",
  "create_document",
  "inspect_document",
  "inspect_document_state",
  "inspect_selection",
  "inspect_feature",
  "inspect_geometry",
  "inspect_assembly",
  "mass_properties",
  "cut_list",
  "belt_length",
  "check_motion",
  "check_interference",
  "check_definition",
  "capture_view",
  "run_steps",
  "export_face_dxf",
  "list_materials",
  "save_material",
  "delete_material",
  "measure",
  "analyze_interference",
  "analyze_printability",
  "export_file",
  "export_drawing",
  "render_drawing",
  "set_selection",
  "set_viewport",
  "dismiss_preview",
]);
/** Tools that act on the library or create documents, never on the open document. */
const global = new Set([
  "create_document",
  "list_documents",
  "list_materials",
  "save_material",
  "delete_material",
  "import_part",
  "git_status",
  "git_commit",
  "git_branches",
  "git_create_branch",
  "git_switch",
  "git_merge",
  "git_resolve",
  "git_abort_merge",
  "git_pull",
  "git_push",
]);
export interface DocumentSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  bodyCount: number;
  branch?: { name: string; parentId: string };
}
export function useCad() {
  const [view, setView] = useState<View | null>(null),
    [loading, setLoading] = useState(true),
    [pending, setPending] = useState(0),
    [error, setError] = useState(""),
    [documents, setDocuments] = useState<DocumentSummary[]>([]),
    [transfer, setTransfer] = useState<ViewTransfer>({
      active: false,
      received: 0,
      total: 0,
    });
  const latest = useRef<View | null>(null),
    queue = useRef<Promise<unknown>>(Promise.resolve()),
    pendingRef = useRef(0),
    transferRef = useRef(transfer);
  latest.current = view;
  const accept = (v: View) => {
    if (!v?.document) return;
    const current = latest.current;
    if (
      current?.document.id === v.document.id &&
      v.document.revision < current.document.revision
    )
      return;
    latest.current = v;
    setView(v);
    if (!transferRef.current.active) void context(v).catch(() => {});
  };
  const refreshDocuments = async () => {
    const result = await call<{ documents: DocumentSummary[] }>(
      "list_documents",
    );
    setDocuments(result.documents);
    return result.documents;
  };
  useEffect(() => {
    onView(accept);
    onTransfer((state) => {
      transferRef.current = state;
      setTransfer(state);
      if (state.error) setError(state.error);
      else if (state.active) setError("");
    });
    void (async () => {
      try {
        await initialize();
        await refreshDocuments();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
    // Pick up edits made by the assistant through the same document.
    const timer = setInterval(() => {
      const current = latest.current;
      if (
        !current ||
        pendingRef.current ||
        transferRef.current.active ||
        transferRef.current.error ||
        document.hidden
      )
        return;
      void call("inspect_document_state", { documentId: current.document.id })
        .then(async (state: any) => {
          const now = latest.current;
          if (
            pendingRef.current ||
            !now ||
            now.document.id !== state.documentId ||
            (state.revision === now.document.revision &&
              JSON.stringify(state.selection) ===
                JSON.stringify(now.document.selection) &&
              state.previewId === (now.preview?.id ?? null))
          )
            return;
          const updated = await call<View>("inspect_document", {
            documentId: state.documentId,
          });
          if (!pendingRef.current) accept(updated);
        })
        .catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, []);
  /** Run a tool after every earlier command, using the newest revision. */
  const execute = <T = any>(
    name: string,
    args: Record<string, any> = {},
  ): Promise<T> => {
    if (transferRef.current.active || transferRef.current.error)
      return Promise.reject(
        Error(
          "Wait for the model to finish loading, or reopen it if loading was interrupted",
        ),
      );
    pendingRef.current++;
    setPending((n) => n + 1);
    const job = queue.current.then(async () => {
      const current = latest.current;
      const full =
        current && !global.has(name)
          ? {
              documentId: current.document.id,
              ...(unrevised.has(name)
                ? {}
                : { expectedRevision: current.document.revision }),
              ...args,
            }
          : args;
      try {
        const result = await call<any>(name, full);
        if (result?.document && result?.geometry) accept(result);
        return result as T;
      } catch (e) {
        const message = (e as Error).message;
        if (message.includes("Revision conflict") && current)
          accept(
            await call<View>("inspect_document", {
              documentId: current.document.id,
            }),
          );
        throw e;
      }
    });
    queue.current = job
      .catch(() => {})
      .finally(() => {
        pendingRef.current--;
        setPending((n) => n - 1);
      });
    return job;
  };
  /** Same as execute but reports errors to the shared error line. */
  const run = (name: string, args: Record<string, any> = {}) =>
    execute(name, args).catch((e) => {
      setError((e as Error).message);
      return undefined;
    });
  const open = async (documentId: string) => {
    try {
      accept(await call<View>("inspect_document", { documentId }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const create = async (name: string) => {
    try {
      const v = await call<View>("create_document", { name });
      accept(v);
      void refreshDocuments();
      return v;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return {
    view,
    latest,
    loading,
    busy: pending > 0 || transfer.active,
    transfer,
    error,
    setError,
    documents,
    refreshDocuments,
    execute,
    run,
    accept,
    open,
    create,
  };
}
export type Cad = ReturnType<typeof useCad>;
