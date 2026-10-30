# Vibe CAD 1.1

## 1.1.4 installation lifetime

The launcher gives each running stdio process one immutable copy of its runtime bundles, editor HTML and WASM kernel. Plugin upgrades can then remove an older installation without breaking a live session's resource reads, delayed worker startup or inherited working directory. Assets are removed on process exit; orphaned runtime snapshots are removed on the next launch. Saved CAD documents are never copied into this runtime directory. No dependencies or network services were added.

This addresses confirmed host logs repeatedly reading a deleted 1.1.1 editor HTML path after installation of a newer plugin. Standalone verification now removes the disposable extracted installation while its process is running, before its first geometry operation, and verifies geometry, STEP export, editor resources and cleanup. This is a packaging lifetime fix, not proof that all renderer crashes or geometry failures are fixed.

The proposed broader automatic WebAssembly retry and unrelated rollback changes were removed. The isolated forest, mounting-tab join, original assembly followed by forest edits, and forced-garbage-collection sequence all passed without retries; the long-session native kernel failure has not yet been reproduced or attributed to a specific source change.

Native 1.1.3 opened the saved Yosemite assembly and played/paused its live 24-hour controls; Stop restored the saved pose. Native verification of the new launcher requires one activation restart.

## 1.1.3 live assembly motion and bounded recovery

Rigid component moves now solve current mates against cached topology and re-place only affected bodies; solid features are not rebuilt. Placement-only replies and polling retain cached shapes and stationary GPU buffers. Continuous dragging and playback update object matrices locally, with no tools, mesh transfers or revisions per frame. A drag commits once on release. Selecting an attached member resolves its rigid driving part; ordinary geared followers can also drive their mate relation. Linear and rotary travel limits remain active. Evaluate > Motion adds play/pause, stop, scrubbing and a configurable cycle duration. Collision/clearance booleans are explicitly requested, not launched automatically as fields change. Shape-changing belts/in-context sketches retain their required geometry evaluation and are excluded from rigid playback.

Closing an editor now unmounts the application viewport; the former closed-state branch was accidentally inside the feature timeline. Renderer heartbeats are serialized with bounded timeouts, retry transient failures and protect active drags/drafts. Live editors can reload in place and resume the saved document without creating another panel. A requested teardown is reported separately from host acknowledgement. Stale sessions remain visible with user instructions; forgetting a stale session requires confirmation that its host tab was manually closed. The plugin cannot execute a close/reload command inside a process that has already crashed, and this host exposes no assistant-side dead-panel close API.

View transfers reject oversized decoded views and oversized records before GPU allocation. WebGL avoids multisampled framebuffers and prefers low-power graphics. Rendering is event driven and suspends when hidden, while retaining the existing framebuffer/geometry budgets, buffer reuse and single automatic WebGL recovery. These reduce pressure; native crash freedom is not certified by browser tests. A scoped copy of the 47-document Yosemite project measured a median rigid move of 3376 ms on installed 1.1.2 and 113 ms on updated source 1.1.3 (eight moves each), with geometry replies dropping from eight to zero. The native originals were byte-identical before/after; temporary benchmark stores were deleted. The measured 61 MB initial view remains a real cost. A 32 MiB record limit accommodates its largest 19.4 MB vendor body within the 64 MiB total transfer cap. Browser interaction confirmed no intermediate drag commits, retained mesh buffers during dragging/playback, no playback tool calls, zero idle render scheduling, and context release on editor closure. Focused regression checks and extracted-package verification passed; the developer benchmarks are not part of normal iteration or the shipped runtime. Native verification of 1.1.3 remains pending activation after the user restarts Codex.

## 1.1.2 camera and selection traffic

Camera saves now commit metadata without requesting solid geometry, and camera/selection replies acknowledge only the updated context. The editor merges same-revision acknowledgements while retaining its geometry objects; an acknowledgement for a different revision cannot relabel stale geometry. Automatic initial framing does not save a camera change. Warm geometry updates retain the previous complete view until the replacement stream completes.

This removes a camera-save/full-assembly-stream/automatic-fit feedback path observed during native testing after a second host renderer crash. Regression checks forbid a geometry lookup for camera saves and limit context replies to small metadata responses. This is an additional fix; the native host still needs verification after activating 1.1.2.

## 1.1.1 graphics recovery

Streaming an assembly now retains GPU buffers for unchanged bodies instead of rebuilding every previously received body for each chunk. Framebuffer dimensions and estimated geometry allocations are bounded before upload. Closing a scene releases the environment render target, triad textures, section materials, and graphics context. A lost WebGL context gets one automatic recreation; repeated failures offer a Restore action without discarding the current editor document. React errors have a reload screen.

The observed native host log records a sandbox renderer process crash (reason `crashed`, exit code 5); it does not establish an out-of-memory cause. An entire host process crash cannot be intercepted by an in-process React boundary or WebGL handler. Browser fault-injection checks are separate from native-host verification after restart.

Saved documents remain authoritative for the editor and tools. This update adds typed bulk JSON edits and dry-run validation, intended motion declarations, signed linear/angular travel limits, and live drag projection through existing mates. A motion declaration checks the expected remaining freedom; it never replaces missing mates.

Artwork sketches may capture fixed profiles within a bounded geometry budget. Functional interfaces should retain dimensions and relations. Bulk edits preserve feature IDs, validate the candidate, and commit one revision only after a successful rebuild. Structure-only validation cannot certify assembly mates; geometry validation rebuilds the candidate without saving it.

Only `open_cad` opens an editor. Saved unused editors can request host closure and dispose their renderer; unsaved drafts are protected. The editor registry limits the active working set to five. Legacy editors need to load the new bundle before they can participate. Host teardown requests may be declined; a retired editor still releases its renderer.

Camera orbit has no polar-angle restriction. Front is XY viewed from +Z, with Y up; existing sketch planes and legacy drawing conventions are preserved. Geometry, imported-part and transfer caches, and undo history are bounded. Default project archives retain the current feature tree and linked parts without obsolete undo states.

Pause takes effect at the next batch step. Stop cancels the active kernel operation and keeps already committed steps. Manual edits while paused require replanning. Chat messages are delivered by the host: choose Settings > General > Follow-up behavior > Steer for immediate steering instead of queuing. The plugin does not change this setting.

Update the local marketplace source with the packaged files, reinstall, and restart the desktop app. Read `engine_info` after restarting to verify the active runtime. Automated tests and standalone package verification do not establish native editor rendering; verify that separately in the restarted host.
