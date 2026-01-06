# @outburn/fume-mapping-provider

A TypeScript module for managing pre-defined, named FUME expressions (mappings) from multiple sources: files, FHIR servers, and FHIR packages.

## Features

- 🚀 **Lightning-fast user mappings**: In-memory cache for file and server mappings
- 📁 **File mappings**: Load from local `.fume` files (or custom extensions)
- 🌐 **Server mappings**: Load from FHIR servers with automatic pagination
- 📦 **Package mappings**: Load from FHIR packages via `fhir-package-explorer`
- 🔄 **Smart collision handling**: File mappings override server mappings
- 🔍 **Flexible search**: Find package mappings by URL, ID, or name
- 📝 **Structured logging**: Optional logger interface support
- ✅ **FUME validation**: Filters StructureMaps by FUME-specific extensions

## Architecture

The provider separates mappings into two categories:

### User Mappings (File + Server)
- **Fast access**: Loaded once, cached in memory
- **Key-based lookup**: Use unique keys for instant retrieval
- **Collision resolution**: File mappings override server mappings with warnings
- **Refresh by key**: Update individual mappings without full reload

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
  canonicalBaseUrl: 'http://example.com', // Optional, default is 'http://example.com'
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

// Optimistic update - provide mapping directly to avoid roundtrip
// Useful after successfully updating the FHIR server
const updatedMapping = {
  key: 'my-mapping-key',
  expression: '$output = { updated: true }',
  source: 'server',
  sourceServer: 'http://my-server.com'
};
await provider.refreshUserMapping('my-mapping-key', updatedMapping);

// Optimistic delete - pass null to remove from cache
await provider.refreshUserMapping('deleted-key', null);
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

### UserMapping Structure

```typescript
interface UserMapping {
  key: string;                    // Unique identifier
  expression: string;             // FUME expression
  source: 'file' | 'server';     // Origin
  filename?: string;              // For file mappings
  sourceServer?: string;          // For server mappings
  name?: string;                  // StructureMap.name
  url?: string;                   // StructureMap.url
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
- **Server-only**: Not loaded from files or packages
- **Consolidated**: Always served as a single object
- **Cached**: Loaded once during initialization for fast access

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

### Reload Aliases

```typescript
// Reload from server (updates cache)
await provider.reloadAliases();
```

### Optimistic Updates

```typescript
// Register or update a single alias (no server roundtrip)
provider.registerAlias('newKey', 'newValue');

// Delete an alias from cache
provider.deleteAlias('oldKey');
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
// mapping.source === 'file'
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
// { key: 'mapping1', expression: '...', source: 'file' }
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
- `initialize(): Promise<void>` - Load user mappings into cache
- `reloadUserMappings(): Promise<void>` - Reload all user mappings
- `refreshUserMapping(key: string): Promise<UserMapping | null>` - Refresh specific user mapping

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
- `registerAlias(name: string, value: string): void` - Register/update a single alias (optimistic cache update)
- `deleteAlias(name: string): void` - Delete a specific alias from cache
- `getAliases(): AliasObject` - Get all cached aliases as single object
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
  fileExtension?: string;            // Default: '.fume'
  fhirClient?: any;                  // FHIR client instance
  packageExplorer?: any;             // FPE instance
  logger?: Logger;                   // Optional logger
  canonicalBaseUrl?: string;         // Default: 'http://example.com'
}
```

## License

MIT  
© Outburn Ltd. 2022–2025. All Rights Reserved.
