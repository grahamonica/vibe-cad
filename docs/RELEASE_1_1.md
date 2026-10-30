# Vibe CAD 1.1

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
