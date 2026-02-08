## Automatic change tracking (single-feature roadmap)

### Goal
Make the provider read-only and self-healing by automatically keeping its in-memory cache (mappings and aliases) aligned with external sources.

This replaces consumer-driven, optimistic “I already changed the external state—just update your cache” workflows.

### High-level behavior
The module maintains a cache of:
- **Aliases** (resolved from one or more sources; may include a server ConceptMap and/or a file like `aliases.json` depending on current behavior. Precedence-based key collision resolved)
- **Mappings** (StructureMaps from server and mapping files from disk, including JSON mapping files)

It keeps those caches fresh via:
1. **Regular polling** for incremental changes (files + FHIR resources from server)
2. **Periodic forced resync** (“full cache reload”) at a longer interval (pick a good default, and make it user configurable) to reconcile missed events (especially server-side deletes).

All refresh operations must respect the existing collision/override precedence rules.

### Breaking API and behavior changes
- Remove **all optimistic update/delete APIs** for aliases and mappings (no key-specific create/update/delete that takes an “after” value from consumers).
- Keep **refresh triggers** only:
	- full refresh from source(s)
	- focused mapping refreshes that re-fetch from the real source (file/resource) and update cache only if different
- Alias-specific CRUD is removed entirely:
	- alias refresh is always a **full refresh** of the entire alias collection
	- specific alias deletion is implicit (it disappears on full refresh if absent)
- Remove the alias metadata source type `local` (it becomes obsolete with this design).
- Document all breaking changes in `MIGRATION_0.3.0_TO_1.0.0.md` (including removed methods and removed `local`).

### Cache update rules (must-haves)
Applies to scheduled polling, user-requested refreshes, and forced resync.

- **No runtime cache resets** for mappings.
- Updates must be **incremental and safe**:
	- never delete-and-recreate a specific key
	- never update an unchanged entry
	- apply changes one-at-a-time (no “drop everything and rebuild” behavior at runtime)

#### Change detection semantics
- For mapping entries: update cache **only if there is a real difference** in content (it's a string, as long as it's not a json file mapping; see below).
- For **JSON mappings from files** (`sourceType`=file, `source` path has a `.json` extension): treat a change in *serialized* content as a real change even if semantically equal. These can have any JSON datatype.
	- Example: object key reordering counts as a change.

### Regular polling
Regular polling detects and applies changes without requiring consumers to call optimistic CRUD methods.

#### File polling (mapping folder)
Requirements:
- Must be reliable and cross-platform.
- Must work in Kubernetes with multiple pods reading a shared volume.
	- No leader election.
	- It’s acceptable for all pods to poll on the same interval (expected ~50–200 files).
- Polling interval must be configurable; recommended default: **5 seconds**.
- Deletions of mapping files should be detected and reflected in cache if possible.
- Must not be the naive approach of “read the entire folder and replace the entire cache every poll”.
	- Use a best-practice sweet spot: avoid reading unchanged files when possible.
- Cache updates remain incremental.

Notes:
- Files are expected to be modest in size (text transformation programs or json objects). Full reads are tolerable if required, but may justify a higher default polling interval.

#### Server polling (FHIR)
There are two server-backed resource tracking behaviors:
1) one specific ConceptMap id (aliases)
2) StructureMap resources matching startup search criteria (mappings)

Constraints:
- Server polling uses polling only.
- Server polling interval must be configurable, have a sane default (suggest **30 seconds**), and be the **same** interval for both resource types.
- The REST interaction differs per resource type (details below).

##### 1) Aliases via ConceptMap/{id}
The alias ConceptMap has a known identity (detected at startup or user-defined). Use conditional reads to detect changes.

Cache must retain `meta.lastUpdated` and `meta.versionId` (when present) for the cached resource.

Read strategy:
- If cached `meta.versionId` exists: use it as ETag with `If-None-Match`.
- Else if cached `meta.lastUpdated` exists: use `If-Modified-Since`.
- Else: unconditional read every time.

Response handling:
- `304 Not Modified`: no cache change.
- `200 OK`: rebuild aliases and replace the cached alias collection (full refresh semantics), but only write to cache if the final alias object differs from what’s cached.
- `404` or `410`: resource deleted.
	- Reset the instance-level saved alias resource id if it wasn't user configured.
	- Trigger a full refresh of aliases from all sources.

##### 2) Mappings via StructureMap
Two cases:

**Focused refresh (user requests mapping X)**
- Treat as a known-identity resource read.
- Use the same conditional-read mechanics as ConceptMap above (`If-None-Match` / `If-Modified-Since` / unconditional fallback).

**Regular polling (interval-based)**
- Execute the same StructureMap search used at startup (including client-side fallback filtering), but append `_lastUpdated` to narrow results.
- This polling path updates **zero or more** cache entries returned by the search.
- Regular polling does **not** handle deletes; that is expected.
	- Deletes are reconciled during user-requested full refreshes and during forced resync.

### Forced resync (“full cache reload”)
Implement a scheduled forced resync at a longer interval than regular polling.

Purpose:
- Align cache state with all sources.
- Compensate for missed events (especially server-deleted StructureMaps).

Requirements:
- Must cover **aliases + mappings** and **all source types**.
- Interval must be configurable; choose a sane default (suggest **1 hour**).

Forced resync behavior:
- **Mappings**: do a full read of all sources, construct the final state in memory (after collision rules), then update the cache incrementally:
	1) update entries with newer versions/changed content
	2) delete entries missing from the newly calculated state
	3) leave unchanged entries untouched
	- Never reset the cache.
- **Aliases**: compute the full final alias key/value object and replace the cached alias object only if it differs.

### User-requested refreshes
User-requested refreshes remain supported, but they are never optimistic.

- **Full refresh**: re-read from the selected sources, build final state in memory, then apply incremental cache updates (mappings) and full-replacement semantics (aliases).
- **Focused refresh**: a trigger to refetch the specific resource and/or file from its source and apply changes only if different.
	- For JSON mappings, “different” is based on serialized content.

### Quality gates
- Add tests for change tracking from all source types (use short polling intervals in tests).
- Update or remove tests that relied on removed methods (optimistic CRUDs).
- Document all breaking changes in `MIGRATION_0.3.0_TO_1.0.0.md`.