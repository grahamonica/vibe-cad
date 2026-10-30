# Vibe CAD 1.1

Saved documents remain authoritative for the editor and tools. This update adds typed bulk JSON edits and dry-run validation, intended motion declarations, signed linear/angular travel limits, and live drag projection through existing mates. A motion declaration checks the expected remaining freedom; it never replaces missing mates.

Artwork sketches may capture fixed profiles within a bounded geometry budget. Functional interfaces should retain dimensions and relations. Bulk edits preserve feature IDs, validate the candidate, and commit one revision only after a successful rebuild. Structure-only validation cannot certify assembly mates; geometry validation rebuilds the candidate without saving it.

Only `open_cad` opens an editor. Saved unused editors can request host closure and dispose their renderer; unsaved drafts are protected. The editor registry limits the active working set to five. Legacy editors need to load the new bundle before they can participate. Host teardown requests may be declined; a retired editor still releases its renderer.

Camera orbit has no polar-angle restriction. Front is XY viewed from +Z, with Y up; existing sketch planes and legacy drawing conventions are preserved. Geometry, imported-part and transfer caches, and undo history are bounded. Default project archives retain the current feature tree and linked parts without obsolete undo states.

Pause takes effect at the next batch step. Stop cancels the active kernel operation and keeps already committed steps. Manual edits while paused require replanning. Chat messages are delivered by the host: choose Settings > General > Follow-up behavior > Steer for immediate steering instead of queuing. The plugin does not change this setting.

Update the local marketplace source with the packaged files, reinstall, and restart the desktop app. Read `engine_info` after restarting to verify the active runtime. Automated tests and standalone package verification do not establish native editor rendering; verify that separately in the restarted host.
