import { FhirClient } from '@outburn/fhir-client';
import type { FhirPackageIdentifier, Logger, Resource } from '@outburn/types';
import { FhirPackageExplorer } from 'fhir-package-explorer';

/**
 * Extended Resource type with FPE enrichment properties
 */
export interface EnrichedResource extends Resource {
  /** Package ID enriched by fhir-package-explorer */
  __packageId?: string;
  /** Package version enriched by fhir-package-explorer */
  __packageVersion?: string;
  /** Filename enriched by fhir-package-explorer */
  __filename?: string;
}

/**
 * User mapping metadata (from file or server)
 */
export interface UserMappingMetadata {
  /** Unique key (ID) for the mapping */
  key: string;
  
  /** Source: 'file' or 'server' */
  source: 'file' | 'server';
  
  /** Filename (for file sources) */
  filename?: string;
  
  /** Source FHIR server URL (for server sources) */
  sourceServer?: string;
  
  /** StructureMap resource name (if applicable) */
  name?: string;
  
  /** StructureMap canonical URL (if applicable) */
  url?: string;
}

/**
 * A complete user mapping with expression and metadata
 */
export interface UserMapping extends UserMappingMetadata {
  /**
   * Mapping value.
   * - For text-based mappings (e.g. .fume): string
   * - For JSON mappings (*.json): parsed JSON value (can be string/object/array/number/boolean/null)
   */
  expression: unknown;
}

/**
 * Package mapping metadata
 */
export interface PackageMappingMetadata {
  /** Resource ID */
  id: string;
  
  /** Package ID */
  packageId: string;
  
  /** Package version */
  packageVersion: string;
  
  /** Filename in package */
  filename: string;
  
  /** StructureMap resource name (if applicable) */
  name?: string;
  
  /** StructureMap canonical URL (if applicable) */
  url?: string;
}

/**
 * A complete package mapping with expression and metadata
 */
export interface PackageMapping extends PackageMappingMetadata {
  /** The FUME expression */
  expression: string;
}

/**
 * FHIR StructureMap resource (simplified)
 * Extended with FPE enrichment properties
 */
export interface StructureMap extends EnrichedResource {
  resourceType: 'StructureMap';
  id: string;
  url?: string;
  identifier?: Array<{
    use?: string;
    type?: {
      text?: string;
    };
    system?: string;
    value?: string;
  }>;
  name?: string;
  title?: string;
  status?: string;
  date?: string;
  useContext?: Array<{
    code?: {
      system?: string;
      code?: string;
      display?: string;
    };
    valueCodeableConcept?: {
      coding?: Array<{
        system?: string;
        code?: string;
        display?: string;
      }>;
      text?: string;
    };
  }>;
  group?: Array<{
    name?: string;
    typeMode?: string;
    input?: Array<{
      name?: string;
      mode?: string;
    }>;
    rule?: Array<{
      extension?: Array<{
        url?: string;
        valueExpression?: {
          language?: string;
          expression?: string;
        };
      }>;
      name?: string;
      source?: Array<{
        context?: string;
      }>;
    }>;
  }>;
}

/**
 * Configuration options for FumeMappingProvider
 */
export interface FumeMappingProviderConfig {
  /** Path to folder containing mapping files */
  mappingsFolder?: string;
  
  /** File extension for mapping files (default: '.fume') */
  fileExtension?: string;
  
  /** Injected FHIR package explorer instance */
  packageExplorer?: FhirPackageExplorer;
  
  /** Injected FHIR client instance */
  fhirClient?: FhirClient;
  
  /** Optional logger instance for structured logging */
  logger?: Logger;
  
  /** Canonical base URL for generated FHIR resources (default: 'http://example.com') */
  canonicalBaseUrl?: string;
}

/**
 * Options for getting package mappings
 */
export interface GetPackageMappingOptions {
  /** Filter by package context - supports string or FhirPackageIdentifier */
  packageContext?: string | FhirPackageIdentifier;
}

/**
 * Alias object - key-value mappings
 */
export interface AliasObject {
  [key: string]: string;
}

/**
 * Alias source type.
 * - 'file'   : Loaded from aliases.json in mappingsFolder
 * - 'server' : Loaded from ConceptMap on FHIR server
 * - 'builtIn': Bundled defaults
 * - 'local'  : Optimistic runtime override via registerAlias
 */
export type AliasSourceType = 'file' | 'server' | 'builtIn' | 'local';

/**
 * Alias entry with metadata.
 */
export interface AliasWithMetadata {
  value: string;
  sourceType: AliasSourceType;
  /**
   * String pointing to the source.
   * - server: `${baseUrl}/ConceptMap/${id}`
   * - file: absolute path to aliases.json
   * - builtIn/local: descriptive identifier
   */
  source: string;
}

/**
 * Alias object with per-alias metadata.
 */
export interface AliasObjectWithMetadata {
  [key: string]: AliasWithMetadata;
}

/**
 * FHIR ConceptMap resource (simplified)
 */
export interface ConceptMap extends Resource {
  resourceType: 'ConceptMap';
  id?: string;
  url?: string;
  name?: string;
  status?: string;
  publisher?: string;
  description?: string;
  date?: string;
  useContext?: Array<{
    code?: {
      system?: string;
      code?: string;
      display?: string;
    };
    valueCodeableConcept?: {
      coding?: Array<{
        system?: string;
        code?: string;
        display?: string;
      }>;
      text?: string;
    };
  }>;
  group?: Array<{
    source?: string;
    target?: string;
    element?: Array<{
      code?: string;
      display?: string;
      target?: Array<{
        code?: string;
        display?: string;
        equivalence?: string;
      }>;
    }>;
  }>;
}
