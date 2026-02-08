# Migration guide: 0.3.0 → 1.0.0

This guide covers breaking changes required when upgrading from 0.3.0 to 1.0.0.

## 1) Mapping metadata structure change
**Before (0.3.0):**
- `source`: `'file' | 'server'`
- `filename` (file sources)
- `sourceServer` (server sources)

**After (1.0.0):**
- `sourceType`: `'file' | 'server'`
- `source`: string pointing to the exact location
  - server: full URL of the StructureMap resource
  - file: absolute path to the mapping file

**Required changes:**
- Replace `source` with `sourceType`.
- Replace `filename`/`sourceServer` with a unified `source` string.

## 2) Quick migration checklist
- Update mapping metadata to `sourceType` + `source`.
- Remove use of `filename` and `sourceServer`.

## 3) Optimistic CRUD APIs removed
The following optimistic APIs are removed and must be replaced with source-backed refreshes:

- `registerAlias(name, value)`
- `deleteAlias(name)`
- `refreshUserMapping(key, mapping)` (optimistic update)
- `refreshUserMapping(key, null)` (optimistic delete)

**Replacement:**
- Use `refreshUserMapping(key)` to re-fetch from file/server.
- Use `reloadAliases()` to reload aliases from real sources.

## 4) Alias `local` source type removed
Alias metadata no longer includes `sourceType: 'local'`. Aliases now originate only from:

- `builtIn`
- `server`
- `file`

## 5) Automatic change tracking (new defaults)
`initialize()` now starts automatic polling and forced resync by default:

- File polling: default 5000 ms
- Server polling: default 30000 ms
- Forced resync: default 3600000 ms

Disable any interval by setting it to `<= 0` in `FumeMappingProviderConfig`.
