# @outburn/fume-mapping-provider

A TypeScript module for managing pre-defined, named FUME expressions (mappings) from multiple sources: files, FHIR servers, and FHIR packages.

## Features

- 🚀 **Lightning-fast user mappings**: In-memory cache for file and server mappings
- 📁 **File mappings**: Load from local `.fume` files (or custom extensions)
- 🌐 **Server mappings**: Load from FHIR servers with automatic pagination
- 📦 **Package mappings**: Load from FHIR packages via `fhir-package-explorer`
- 🔄 **Smart collision handling**: File mappings override server mappings
- 🛰️ **Automatic change tracking**: Poll files and FHIR server resources with incremental updates
- 🔍 **Flexible search**: Find package mappings by URL, ID, or name
- 📝 **Structured logging**: Optional logger interface support
- ✅ **FUME validation**: Filters StructureMaps by FUME-specific extensions

## Architecture

The provider separates mappings into two categories:

### User Mappings (File + Server)
- **Fast access**: Loaded once, cached in memory
- **Key-based lookup**: Use unique keys for instant retrieval
- **Collision resolution**: File mappings override server mappings with warnings
- **Focused refresh by key**: Re-fetch a single mapping from its real source

### Package Mappings
- **Always fresh**: Queried from FPE on demand (FPE handles caching)
- **Immutable**: Packages never change once installed
- **Smart identifier resolution**: Try URL → ID → name automatically
- **Package filtering**: Filter by package context

## Installation

```bash
npm install @outburn/fume-mapping-provider

# Dependencies based on usage:
npm install fhir-package-explorer  # For package mappings
npm install @outburn/fhir-client    # For server mappings
```

## Quick Start

```typescript
import { FumeMappingProvider } from '@outburn/fume-mapping-provider';
import { FhirPackageExplorer } from 'fhir-package-explorer';
import { FhirClient } from '@outburn/fhir-client';

// Setup dependencies
const fhirClient = new FhirClient({ baseUrl: 'https://hapi.fhir.org/baseR4' });
const packageExplorer = await FhirPackageExplorer.create({
  context: ['hl7.fhir.us.core@6.1.0']
});

// Create provider
const provider = new FumeMappingProvider({
  mappingsFolder: './mappings',
  fileExtension: '.fume', // Optional, default is '.fume'
  fhirClient: fhirClient,
  packageExplorer: packageExplorer,
  aliasConceptMapId: 'my-aliases-cm-id', // Optional, skips alias ConceptMap search
  canonicalBaseUrl: 'http://example.com', // Optional, default is 'http://example.com'
  filePollingIntervalMs: 5000,   // Optional, default 5000 (set <= 0 to disable)
  serverPollingIntervalMs: 30000, // Optional, default 30000 (set <= 0 to disable)
  forcedResyncIntervalMs: 3600000, // Optional, default 1 hour (set <= 0 to disable)
  logger: console // Optional
});

// Initialize (loads user mappings into cache)
await provider.initialize();
```

## User Mappings API

### Load and Cache

```typescript
// Initialize loads all user mappings (file + server) into memory
await provider.initialize();

// Reload all user mappings
await provider.reloadUserMappings();

// Refresh specific mapping by key (fetches from source)
await provider.refreshUserMapping('my-mapping-key');
```

### Static JSON Values (*.json)

If `mappingsFolder` is configured, the provider also loads `*.json` files from that folder as **static JSON values**.

- The key is the filename without `.json`
- The value is the parsed JSON value (object/array/string/number/boolean/null)
- The reserved filename `aliases.json` is **never** treated as a static value
- Static JSON values are **not** treated as mappings and do not override `*.fume` mappings; they are exposed via a separate API.

```typescript
// Reload all static JSON values
await provider.reloadStaticJsonValues();

// Refresh a specific static JSON value by key
await provider.refreshStaticJsonValue('myStaticKey');

// Read from cache
const value = provider.getStaticJsonValue('myStaticKey');
// Returns: StaticJsonValue | undefined
```

### Get User Mappings (Lightning Fast ⚡)

```typescript
// Get all user mappings
const mappings = provider.getUserMappings();
// Returns: UserMapping[]

// Get all user mapping keys
const keys = provider.getUserMappingKeys();
// Returns: string[]

// Get metadata only (without expressions)
const metadata = provider.getUserMappingsMetadata();
// Returns: UserMappingMetadata[]

// Get specific mapping by key
const mapping = provider.getUserMapping('my-key');
// Returns: UserMapping | undefined
```

## Automatic Change Tracking

On `initialize()`, the provider automatically starts polling sources to keep the in-memory cache aligned with files and server resources.

- **File polling** (default: 5s): detects changes in mapping files and `aliases.json` incrementally.
- **File polling** (default: 5s): detects changes in mapping files, static JSON value files (`*.json` excluding `aliases.json`), and `aliases.json` incrementally.
- **Server polling** (default: 30s):
  - Aliases: conditional read of the alias ConceptMap (ETag/Last-Modified).
  - Mappings: StructureMap search with `_lastUpdated`.
- **Forced resync** (default: 1h): full refresh of aliases + mappings, applied incrementally.

Disable any polling loop by setting its interval to `<= 0`.

### UserMapping Structure

```typescript
interface UserMapping {
  key: string;                    // Unique identifier
  expression: string;             // FUME expression
  sourceType: 'file' | 'server';  // Origin
  source: string;                 // Absolute file path or full server URL
  name?: string;                  // StructureMap.name
  url?: string;                   // StructureMap.url
}

interface StaticJsonValue {
  key: string;               // Filename without `.json`
  value: unknown;            // Parsed JSON value
  sourceType: 'file';        // Origin
  source: string;            // Absolute file path
}
```

## Package Mappings API

### Get Package Mappings

```typescript
// Get all package mappings
const mappings = await provider.getPackageMappings();

// Filter by package context
const mappings = await provider.getPackageMappings({
  packageContext: 'hl7.fhir.us.core@6.1.0'
});

// Get metadata only (without expressions)
const metadata = await provider.getPackageMappingsMetadata();
```

## Aliases API

### Overview

Aliases are simple key-value string mappings stored in a special ConceptMap resource on the FHIR server. Unlike mappings, aliases are:
- **Server + File**: Loaded from the FHIR server and/or an optional `aliases.json` file in `mappingsFolder`
- **Consolidated**: Always served as a single object
- **Cached**: Kept fresh via automatic change tracking

When both server and file sources are configured:
- **File aliases override server aliases** on key collision (a warning is logged if a logger is provided)
- **Server aliases override built-in aliases**

### Alias Resource Structure

FUME aliases are stored in a ConceptMap resource with this specific `useContext`:

```typescript
{
  code: {
    system: "http://snomed.info/sct",
    code: "706594005"
  },
  valueCodeableConcept: {
    coding: [{
      system: "http://codes.fume.health",
      code: "fume"
    }]
  }
}
```

The server is queried with: `GET [baseUrl]/ConceptMap?context=http://codes.fume.health|fume&name=FumeAliases`

### Get Aliases

```typescript
// Get all aliases (fast, cached)
const aliases = provider.getAliases();
// Returns: { [key: string]: string }

// Get all aliases with per-alias metadata (source + sourceType)
const aliasesWithMeta = provider.getAliasesWithMetadata();
// Returns: { [key: string]: { value: string; sourceType: 'file'|'server'|'builtIn'; source: string } }

// Get the ConceptMap id used for server aliases (if loaded)
// Downstream consumers can use this id when updating the alias ConceptMap
const aliasResourceId = provider.getAliasResourceId();
// Returns: string | undefined

// Example:
// {
//   "patientSystemUrl": "http://example.com/patients",
//   "defaultLanguage": "en-US",
//   "apiVersion": "v1"
// }
```

### File Aliases (`aliases.json`)

If `mappingsFolder` is configured, the provider will look for a special `aliases.json` file inside it.

Rules:
- If `mappingsFolder` is not set, file aliases are not supported.
- If `aliases.json` is missing, no file aliases are loaded.
- If `aliases.json` exists but is invalid, a warning is logged and the file is ignored.

Example `aliases.json`:

```json
{
  "patientSystemUrl": "http://example.com/patients",
  "defaultLanguage": "en-US",
  "apiVersion": "v1"
}
```

Validation:
- Must be a JSON object
- Keys must match `^[A-Za-z0-9_]+$` (no whitespace or operators like `-` or `.`)
- Values must be strings

### Reload Aliases

```typescript
// Reload from configured sources (server and/or mappingsFolder)
await provider.reloadAliases();
```

### Transforming Alias Resources

```typescript
// ConceptMap → Alias Object
const aliases = provider.conceptMapToAliasObject(conceptMap);

// Alias Object → ConceptMap
const conceptMap = provider.aliasObjectToConceptMap(aliases, existingConceptMap);
```

## Package Mappings API

### Get by Identifier

Automatically tries URL → ID → name in order, returns first match:

```typescript
// Try to find by URL, ID, or name
const mapping = await provider.getPackageMapping('patient-transform');
// First tries as URL, then ID, then name

// With package filtering
const mapping = await provider.getPackageMapping('patient-transform', {
  packageContext: 'hl7.fhir.us.core@6.1.0'
});
```

### PackageMapping Structure

```typescript
interface PackageMapping {
  id: string;                // StructureMap.id
  expression: string;        // FUME expression
  packageId: string;         // Package ID
  packageVersion: string;    // Package version
  filename: string;          // File in package
  name?: string;             // StructureMap.name
  url?: string;              // StructureMap.url
}
```

## Collision Handling

When a file mapping has the same key as a server mapping:

1. **File mapping wins** (overrides server mapping)
2. **Warning is logged** (if logger provided)
3. **Refresh checks file first**, falls back to server if file deleted

```typescript
// File: ./mappings/my-mapping.fume
// expression: InstanceOf: Patient

// Server: StructureMap with id="my-mapping"
// expression: InstanceOf: Patient

// After initialize():
const mapping = provider.getUserMapping('my-mapping');
// mapping.sourceType === 'file'
// mapping.expression === 'InstanceOf: Patient'
// Warning logged: "File mapping 'my-mapping' overrides server mapping"
```

## Examples

### File-Only Setup

```typescript
const provider = new FumeMappingProvider({
  mappingsFolder: './mappings'
});

await provider.initialize();

const keys = provider.getUserMappingKeys();
// ['mapping1', 'mapping2', 'mapping3']

const mapping = provider.getUserMapping('mapping1');
// { key: 'mapping1', expression: '...', sourceType: 'file', source: '/abs/path/mapping1.fume' }
```

### Server-Only Setup

```typescript
const provider = new FumeMappingProvider({
  fhirClient: new FhirClient({ baseUrl: 'https://fhir.server.com' })
});

await provider.initialize();

const mappings = provider.getUserMappings();
// All StructureMaps from server (with FUME extensions)
```

### Package-Only Setup

```typescript
const explorer = await FhirPackageExplorer.create({
  context: ['hl7.fhir.us.core@6.1.0']
});

const provider = new FumeMappingProvider({
  packageExplorer: explorer
});

// No initialize needed for package-only
const mappings = await provider.getPackageMappings();
```

### Combined Setup

```typescript
const provider = new FumeMappingProvider({
  mappingsFolder: './mappings',
  fhirClient: fhirClient,
  packageExplorer: explorer,
  logger: console
});

await provider.initialize(); // Loads user mappings only

// User mappings (fast, cached)
const userKeys = provider.getUserMappingKeys();
const userMapping = provider.getUserMapping('my-key');

// Package mappings (on-demand)
const pkgMappings = await provider.getPackageMappings();
const pkgMapping = await provider.getPackageMapping('patient-transform');
```
## API Reference

### FumeMappingProvider

#### Constructor

```typescript
new FumeMappingProvider(config: FumeMappingProviderConfig)
```

#### Methods

**Initialization:**
- `initialize(): Promise<void>` - Load caches and start automatic change tracking
- `reloadUserMappings(): Promise<void>` - Reload all user mappings
- `refreshUserMapping(key: string): Promise<UserMapping | null>` - Refresh specific user mapping
- `startAutomaticChangeTracking(): void` - Start polling + forced resync
- `stopAutomaticChangeTracking(): void` - Stop polling + forced resync

**User Mappings (Cached, Fast):**
- `getUserMappings(): UserMapping[]` - Get all user mappings
- `getUserMappingKeys(): string[]` - Get all user mapping keys
- `getUserMappingsMetadata(): UserMappingMetadata[]` - Get metadata only
- `getUserMapping(key: string): UserMapping | undefined` - Get specific mapping

**Package Mappings (On-Demand):**
- `getPackageMappings(options?: GetPackageMappingOptions): Promise<PackageMapping[]>` - Get all package mappings
- `getPackageMappingsMetadata(options?: GetPackageMappingOptions): Promise<PackageMappingMetadata[]>` - Get metadata only
- `getPackageMapping(identifier: string, options?: GetPackageMappingOptions): Promise<PackageMapping | null>` - Get by identifier

**Aliases (Cached, Fast):**
- `reloadAliases(): Promise<void>` - Reload all aliases from server
- `getAliases(): AliasObject` - Get all cached aliases as single object
- `getAliasesWithMetadata(): AliasObjectWithMetadata` - Get all cached aliases with metadata
- `getAliasResourceId(): string | undefined` - Get ConceptMap id for server aliases (if loaded)

**Converters:**
- `getCanonicalBaseUrl(): string` - Get canonical base URL used for generated resources
- `structureMapToExpression(structureMap: StructureMap): string | null` - Extract FUME expression from StructureMap
- `expressionToStructureMap(mappingId: string, expression: string): StructureMap` - Create StructureMap from expression (uses canonical base URL)
- `conceptMapToAliasObject(conceptMap: ConceptMap): AliasObject` - Transform ConceptMap to alias object
- `aliasObjectToConceptMap(aliases: AliasObject, existingConceptMap?: ConceptMap): ConceptMap` - Transform alias object to ConceptMap (uses canonical base URL)

### Configuration

```typescript
interface FumeMappingProviderConfig {
  mappingsFolder?: string;           // Path to .fume files
  fileExtension?: string;            // Default: '.fume' ('.json' is reserved for aliases.json)
  fhirClient?: any;                  // FHIR client instance
  packageExplorer?: any;             // FPE instance
  logger?: Logger;                   // Optional logger
  aliasConceptMapId?: string;        // Optional ConceptMap id for aliases (skips search)
  canonicalBaseUrl?: string;         // Default: 'http://example.com'
  filePollingIntervalMs?: number;    // Default: 5000 (set <= 0 to disable)
  serverPollingIntervalMs?: number;  // Default: 30000 (set <= 0 to disable)
  forcedResyncIntervalMs?: number;   // Default: 3600000 (set <= 0 to disable)
}
```

## License

MIT  
© Outburn Ltd. 2022–2025. All Rights Reserved.
