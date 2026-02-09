import { UserMapping, PackageMapping, StructureMap, GetPackageMappingOptions, ConceptMap, AliasObject, StaticJsonValue } from './types';
import { Logger } from '@outburn/types';
import { structureMapToExpression, conceptMapToAliasObject } from './converters';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Validate that a StructureMap is a FUME mapping
 * Must have the correct useContext and fume expression extension
 */
export function isFumeMapping(structureMap: StructureMap): boolean {
  // Check for fume expression in rule extensions
  /* istanbul ignore if */
  if (!structureMap.group || structureMap.group.length === 0) {
    return false;
  }

  for (const group of structureMap.group) {
    /* istanbul ignore if */
    if (!group.rule || group.rule.length === 0) {
      continue;
    }

    for (const rule of group.rule) {
      if (!rule.extension || rule.extension.length === 0) {
        continue;
      }

      const hasFumeExtension = rule.extension.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ext: any) => ext.url === 'http://fhir.fume.health/StructureDefinition/mapping-expression' &&
               ext.valueExpression?.expression
      );

      if (hasFumeExtension) {
        // Check for appropriate useContext (optional but recommended)
        /* istanbul ignore if */
        if (structureMap.useContext && structureMap.useContext.length > 0) {
          const hasFumeContext = structureMap.useContext.some(
            ctx => ctx.valueCodeableConcept?.coding?.some(
              coding => coding.system?.includes('fume') || coding.code === 'fume'
            )
          );
          return hasFumeContext;
        }
        // If no useContext, accept based on extension alone
        /* istanbul ignore next */
        return true;
      }
    }
  }

  return false;
}

/**
 * Provider for user mappings (file + server)
 * Handles collision resolution: file overrides server
 */
export class UserMappingProvider {
  private fileExtension: string;

  // Generic key validation used across aliases/mappings (safe for JSONata variable binding)
  private static readonly KEY_REGEX = /^[A-Za-z0-9_]+$/;
  // File-based mapping names must also satisfy FHIR Resource.id constraints and best practices:
  // - max length 64
  // - no underscores
  // - must not start with a number (enforced)
  // Combined with KEY_REGEX this becomes: start with letter, then alnum only.
  private static readonly FILE_MAPPING_KEY_REGEX = /^[A-Za-z][A-Za-z0-9]*$/;
  private static readonly FILE_MAPPING_KEY_MAX_LENGTH = 64;
  private static readonly JSON_EXTENSION = '.json';
  private static readonly RESERVED_ALIASES_JSON = 'aliases.json';
  
  constructor(
    private mappingsFolder: string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private fhirClient: any | undefined,
    private logger?: Logger,
    fileExtension?: string
  ) {
    const rawExt = fileExtension ?? '.fume';
    const trimmed = rawExt.trim();
    if (!trimmed) {
      throw new Error(`Invalid fileExtension '${rawExt}'.`);
    }

    const normalized = trimmed.startsWith('.') ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
    this.fileExtension = normalized;

    const ext = normalized;
    if (ext === UserMappingProvider.JSON_EXTENSION) {
      throw new Error(`Invalid fileExtension '${this.fileExtension}'. The '.json' extension is reserved (aliases.json).`);
    }
  }

  private isValidKey(key: string): boolean {
    return UserMappingProvider.KEY_REGEX.test(key);
  }

  private isValidFileMappingKey(key: string): boolean {
    return (
      this.isValidKey(key) &&
      key.length <= UserMappingProvider.FILE_MAPPING_KEY_MAX_LENGTH &&
      UserMappingProvider.FILE_MAPPING_KEY_REGEX.test(key)
    );
  }

  /**
   * Check if a key is valid for static JSON values (generic key regex).
   */
  isValidStaticJsonValueKey(key: string): boolean {
    return this.isValidKey(key) && key !== 'aliases';
  }

  /**
   * @deprecated Use isValidStaticJsonValueKey instead.
   */
  isValidJsonMappingKey(key: string): boolean {
    return this.isValidStaticJsonValueKey(key);
  }

  /**
   * Check if a mapping key is valid for text-based file mappings.
   */
  isValidFileMappingKeyForPolling(key: string): boolean {
    return this.isValidFileMappingKey(key);
  }

  /**
   * Load all user mappings from file and server
   * File mappings override server mappings on key collision (with warning)
   */
  async loadMappings(): Promise<Map<string, UserMapping>> {
    const mappings = new Map<string, UserMapping>();
    
    // Load from server first
    if (this.fhirClient) {
      const serverMappings = await this.loadServerMappings();
      for (const [key, mapping] of serverMappings) {
        mappings.set(key, mapping);
      }
    }
    
    // Load from file (overrides server)
    if (this.mappingsFolder) {
      const fileMappings = await this.loadFileMappings();
      for (const [key, mapping] of fileMappings) {
        if (mappings.has(key)) {
          this.logger?.warn?.(`File mapping '${key}' overrides server mapping with same key`);
        }
        mappings.set(key, mapping);
      }

    }
    
    return mappings;
  }

  /**
   * Refresh a specific user mapping by key
   * Checks both file and server (file takes precedence)
   */
  async refreshMapping(key: string): Promise<UserMapping | null> {
    // Check text-based file mapping
    if (this.mappingsFolder) {
      const fileMapping = await this.loadFileMapping(key);
      if (fileMapping) {
        return fileMapping;
      }
    }
    
    // Check server
    if (this.fhirClient) {
      const serverMapping = await this.loadServerMapping(key);
      if (serverMapping) {
        return serverMapping;
      }
    }
    /* istanbul ignore next */
    return null;
  }

  /**
   * Poll server mappings, optionally filtered by _lastUpdated.
   */
  async searchServerMappings(lastUpdated?: string): Promise<{
    mappings: Map<string, UserMapping>;
    metaByKey: Map<string, { versionId?: string; lastUpdated?: string }>;
  }> {
    const mappings = new Map<string, UserMapping>();
    const metaByKey = new Map<string, { versionId?: string; lastUpdated?: string }>();

    /* istanbul ignore if */
    if (!this.fhirClient) {
      return { mappings, metaByKey };
    }

    try {
      const serverUrl = this.fhirClient.getBaseUrl();
      const normalizedServerUrl = (typeof serverUrl === 'string' ? serverUrl : '').replace(/\/$/, '');
      this.logger?.debug?.(`Polling mappings from FHIR server ${serverUrl}`);

      const params: Record<string, string> = {};
      if (lastUpdated) {
        params._lastUpdated = `ge${lastUpdated}`;
      }

      const resources = await this.fhirClient.search('StructureMap', params, { fetchAll: true, noCache: true });

      if (resources && Array.isArray(resources)) {
        for (const structureMap of resources as StructureMap[]) {
          if (!isFumeMapping(structureMap)) {
            continue;
          }

          if (!this.isValidKey(structureMap.id)) {
            this.logger?.warn?.(
              `Ignoring server mapping '${structureMap.id}' due to invalid mapping name (must match ${UserMappingProvider.KEY_REGEX}).`
            );
            continue;
          }

          const expression = structureMapToExpression(structureMap);
          if (!expression) {
            continue;
          }

          mappings.set(structureMap.id, {
            key: structureMap.id,
            expression,
            sourceType: 'server',
            source: normalizedServerUrl
              ? `${normalizedServerUrl}/StructureMap/${structureMap.id}`
              : (structureMap.url || 'server'),
            name: structureMap.name,
            url: structureMap.url
          });

          metaByKey.set(structureMap.id, {
            versionId: structureMap.meta?.versionId,
            lastUpdated: structureMap.meta?.lastUpdated
          });
        }
      }
    } catch (error) {
      /* istanbul ignore next */
      const serverUrl = this.fhirClient.getBaseUrl();
      /* istanbul ignore next */
      this.logger?.error?.(`Failed to poll mappings from server ${serverUrl}:`, error);
    }

    return { mappings, metaByKey };
  }

  /**
   * Conditional read for a specific StructureMap.
   */
  async conditionalReadServerMapping(
    key: string,
    condition: { versionId?: string; lastUpdated?: string }
  ): Promise<{ status: number; mapping?: UserMapping; meta?: { versionId?: string; lastUpdated?: string } }> {
    /* istanbul ignore if */
    if (!this.fhirClient) {
      return { status: 0 };
    }

    if (!this.isValidKey(key)) {
      this.logger?.warn?.(
        `Ignoring server mapping refresh for invalid mapping name '${key}' (must match ${UserMappingProvider.KEY_REGEX}).`
      );
      return { status: 0 };
    }

    try {
      const serverUrl = this.fhirClient.getBaseUrl();
      const normalizedServerUrl = (typeof serverUrl === 'string' ? serverUrl : '').replace(/\/$/, '');
      const response = await this.fhirClient.conditionalRead('StructureMap', key, condition, { noCache: true });

      if (response.status === 200 && response.resource) {
        const structureMap = response.resource as StructureMap;

        if (!isFumeMapping(structureMap)) {
          return { status: 200 };
        }

        if (!this.isValidKey(structureMap.id)) {
          this.logger?.warn?.(
            `Ignoring server mapping '${structureMap.id}' due to invalid mapping name (must match ${UserMappingProvider.KEY_REGEX}).`
          );
          return { status: 200 };
        }

        const expression = structureMapToExpression(structureMap);
        if (expression) {
          return {
            status: 200,
            mapping: {
              key: structureMap.id,
              expression,
              sourceType: 'server',
              source: normalizedServerUrl
                ? `${normalizedServerUrl}/StructureMap/${structureMap.id}`
                : (structureMap.url || 'server'),
              name: structureMap.name,
              url: structureMap.url
            },
            meta: {
              versionId: structureMap.meta?.versionId,
              lastUpdated: structureMap.meta?.lastUpdated
            }
          };
        }
        return { status: 200 };
      }

      return { status: response.status };
    } catch (_error) {
      /* istanbul ignore next */
      return { status: 0 };
    }
  }

  private async loadFileMappings(): Promise<Map<string, UserMapping>> {
    const mappings = new Map<string, UserMapping>();
    
    /* istanbul ignore if */
    if (!this.mappingsFolder) {
      return mappings;
    }
    
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const files = await fs.readdir(this.mappingsFolder);
      const mappingFiles = files.filter(f => f.endsWith(this.fileExtension));

      for (const file of mappingFiles) {
        try {
          const filePath = path.join(this.mappingsFolder, file);
          const expression = await fs.readFile(filePath, 'utf-8');
          const key = path.basename(file, this.fileExtension);

          if (!this.isValidFileMappingKey(key)) {
            this.logger?.warn?.(
              `Ignoring mapping file '${file}' due to invalid mapping name '${key}'. ` +
                `Mapping names must match ${UserMappingProvider.KEY_REGEX} and also be a valid FHIR id (no underscores, <=64 chars, must not start with a number).`
            );
            continue;
          }

          mappings.set(key, {
            key,
            expression,
            sourceType: 'file',
            source: path.resolve(this.mappingsFolder, file)
          });
        } catch (error) {
          /* istanbul ignore next */
          this.logger?.error?.(`Failed to load mapping from file ${file}:`, error);
        }
      }
    } catch (error) {
      /* istanbul ignore next */
      this.logger?.error?.(`Failed to read mappings folder ${this.mappingsFolder}:`, error);
    }
    
    return mappings;
  }

  async loadFileMapping(key: string): Promise<UserMapping | null> {
    /* istanbul ignore if */
    if (!this.mappingsFolder) {
      return null;
    }

    if (!this.isValidFileMappingKey(key)) {
      this.logger?.warn?.(
        `Ignoring file mapping refresh for invalid mapping name '${key}'. ` +
          `Mapping names must match ${UserMappingProvider.KEY_REGEX} and also be a valid FHIR id (no underscores, <=64 chars, must not start with a number).`
      );
      return null;
    }
    
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const filename = `${key}${this.fileExtension}`;
      const filePath = path.join(this.mappingsFolder, filename);
      const expression = await fs.readFile(filePath, 'utf-8');

      return {
        key,
        expression,
        sourceType: 'file',
        source: path.resolve(this.mappingsFolder, filename)
      };
    } catch (_error) {
      /* istanbul ignore next */
      // File not found
      return null;
    }
  }

  /**
   * @deprecated JSON files are no longer treated as mappings.
   * Use loadStaticJsonValue instead.
   */
  async loadJsonFileMapping(_key: string): Promise<UserMapping | null> {
    return null;
  }

  /**
   * Read raw JSON mapping file contents for change detection.
   */
  /**
   * @deprecated JSON files are no longer treated as mappings.
   * Use readStaticJsonValueRaw instead.
   */
  async readJsonFileRaw(_key: string): Promise<string | null> {
    return null;
  }

  // ===== Static JSON values (file-based) =====

  /**
   * Load all static JSON values from the mappings folder.
   * - Includes `*.json` files
   * - Excludes reserved `aliases.json`
   */
  async loadStaticJsonValues(): Promise<Map<string, StaticJsonValue>> {
    const values = new Map<string, StaticJsonValue>();

    /* istanbul ignore if */
    if (!this.mappingsFolder) {
      return values;
    }

    try {
      const files = await fs.readdir(this.mappingsFolder);
      const jsonFiles = files.filter((f: string) => f.toLowerCase().endsWith(UserMappingProvider.JSON_EXTENSION));

      for (const file of jsonFiles) {
        if (file.toLowerCase() === UserMappingProvider.RESERVED_ALIASES_JSON) {
          continue;
        }

        const key = path.basename(file, UserMappingProvider.JSON_EXTENSION);
        if (!this.isValidStaticJsonValueKey(key)) {
          this.logger?.warn?.(
            `Ignoring static JSON value file '${file}' due to invalid key '${key}' (must match ${UserMappingProvider.KEY_REGEX}).`
          );
          continue;
        }

        try {
          const filePath = path.join(this.mappingsFolder, file);
          const raw = await fs.readFile(filePath, 'utf-8');

          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            this.logger?.warn?.(`Invalid static JSON value file '${file}'; ignoring. ${String(error)}`);
            continue;
          }

          values.set(key, {
            key,
            value: parsed,
            sourceType: 'file',
            source: path.resolve(this.mappingsFolder, file)
          });
        } catch (error) {
          this.logger?.warn?.(`Failed to load static JSON value from file ${file}; ignoring. ${String(error)}`);
        }
      }
    } catch (error) {
      /* istanbul ignore next */
      this.logger?.error?.(`Failed to read mappings folder ${this.mappingsFolder}:`, error);
    }

    return values;
  }

  /**
   * Load a single static JSON value by key.
   */
  async loadStaticJsonValue(key: string): Promise<StaticJsonValue | null> {
    /* istanbul ignore if */
    if (!this.mappingsFolder) {
      return null;
    }

    if (!this.isValidStaticJsonValueKey(key)) {
      return null;
    }

    const filename = `${key}${UserMappingProvider.JSON_EXTENSION}`;
    const filePath = path.join(this.mappingsFolder, filename);

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      try {
        const parsed = JSON.parse(raw);
        return {
          key,
          value: parsed,
          sourceType: 'file',
          source: path.resolve(this.mappingsFolder, filename)
        };
      } catch (error) {
        this.logger?.warn?.(`Invalid static JSON value file '${filename}'; ignoring. ${String(error)}`);
        return null;
      }
    } catch (_error) {
      return null;
    }
  }

  /**
   * Read raw JSON value file contents for change detection.
   */
  async readStaticJsonValueRaw(key: string): Promise<string | null> {
    /* istanbul ignore if */
    if (!this.mappingsFolder) {
      return null;
    }

    if (!this.isValidStaticJsonValueKey(key)) {
      return null;
    }

    const filename = `${key}${UserMappingProvider.JSON_EXTENSION}`;
    const filePath = path.join(this.mappingsFolder, filename);

    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (_error) {
      return null;
    }
  }

  private async loadServerMappings(): Promise<Map<string, UserMapping>> {
    const mappings = new Map<string, UserMapping>();
    /* istanbul ignore if */
    if (!this.fhirClient) {
      return mappings;
    }
    
    try {
      const serverUrl = this.fhirClient.getBaseUrl();
      const normalizedServerUrl = (typeof serverUrl === 'string' ? serverUrl : '').replace(/\/$/, '');
      this.logger?.debug?.(`Loading mappings from FHIR server ${serverUrl}`);
      
      // Search for all StructureMap resources using fetchAll for automatic pagination
      const resources = await this.fhirClient.search('StructureMap', {}, { fetchAll: true, noCache: true });

      if (resources && Array.isArray(resources)) {
        for (const structureMap of resources as StructureMap[]) {
          // Only process FUME mappings
          const isFume = isFumeMapping(structureMap);
          /* istanbul ignore if */
          if (!isFume) {
            continue;
          }
          
          if (!this.isValidKey(structureMap.id)) {
            this.logger?.warn?.(
              `Ignoring server mapping '${structureMap.id}' due to invalid mapping name (must match ${UserMappingProvider.KEY_REGEX}).`
            );
            continue;
          }

          const expression = structureMapToExpression(structureMap);

          if (expression) {
            mappings.set(structureMap.id, {
              key: structureMap.id,
              expression,
              sourceType: 'server',
              source: normalizedServerUrl
                ? `${normalizedServerUrl}/StructureMap/${structureMap.id}`
                : (structureMap.url || 'server'),
              name: structureMap.name,
              url: structureMap.url
            });
          }
        }
      }
    } catch (error) {
      /* istanbul ignore next */
      const serverUrl = this.fhirClient.getBaseUrl();
      /* istanbul ignore next */
      this.logger?.error?.(`Failed to load mappings from server ${serverUrl}:`, error);
    }
    
    return mappings;
  }

  private async loadServerMapping(key: string): Promise<UserMapping | null> {
    
    /* istanbul ignore if */
    if (!this.fhirClient) {
      return null;
    }

    if (!this.isValidKey(key)) {
      this.logger?.warn?.(
        `Ignoring server mapping refresh for invalid mapping name '${key}' (must match ${UserMappingProvider.KEY_REGEX}).`
      );
      return null;
    }
    
    try {
      const serverUrl = this.fhirClient.getBaseUrl();
      const normalizedServerUrl = (typeof serverUrl === 'string' ? serverUrl : '').replace(/\/$/, '');
      const structureMap = await this.fhirClient.read('StructureMap', key, { noCache: true }) as StructureMap;

      if (structureMap && isFumeMapping(structureMap)) {
        if (!this.isValidKey(structureMap.id)) {
          this.logger?.warn?.(
            `Ignoring server mapping '${structureMap.id}' due to invalid mapping name (must match ${UserMappingProvider.KEY_REGEX}).`
          );
          return null;
        }
        const expression = structureMapToExpression(structureMap);
        if (expression) {
          return {
            key: structureMap.id,
            expression,
            sourceType: 'server',
            source: normalizedServerUrl
              ? `${normalizedServerUrl}/StructureMap/${structureMap.id}`
              : (structureMap.url || 'server'),
            name: structureMap.name,
            url: structureMap.url
          };
        }
      }
    } catch (_error) {
      /* istanbul ignore next */
      // Resource not found
    }
    /* istanbul ignore next */
    return null;
  }
}

/**
 * Provider for package mappings
 * No collision handling needed - packages are immutable
 */
export class PackageMappingProvider {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private packageExplorer: any,
    private logger?: Logger
  ) {}

  /**
   * Load all package mappings
   * Returns array since package mappings don't need key-based lookup
   */
  async loadMappings(options?: GetPackageMappingOptions): Promise<PackageMapping[]> {
    const mappings: PackageMapping[] = [];

    try {
      this.logger?.debug?.('Loading StructureMap resources from package context');

      // Build filter
      const filter: Record<string, unknown> = { resourceType: 'StructureMap' };
      if (options?.packageContext) {
        filter.package = options.packageContext;
      }

      // Load all StructureMap resources from the package context
      const structureMaps = await this.packageExplorer.lookup(filter);

      for (const structureMap of structureMaps as StructureMap[]) {
        // Only process FUME mappings
        if (!isFumeMapping(structureMap)) {
          continue;
        }
        
        const expression = structureMapToExpression(structureMap);

        if (expression && structureMap.__packageId && structureMap.__packageVersion) {
          mappings.push({
            id: structureMap.id,
            expression,
            packageId: structureMap.__packageId,
            packageVersion: structureMap.__packageVersion,
            filename: structureMap.__filename as string,
            name: structureMap.name,
            url: structureMap.url
          });
        }
      }
    } catch (error) {
      /* istanbul ignore next */
      this.logger?.error?.('Failed to load mappings from packages:', error);
    }

    return mappings;
  }

  /**
   * Get a package mapping by identifier (tries url, id, name in order)
   * Returns first successful resolution
   */
  async getMapping(identifier: string, options?: GetPackageMappingOptions): Promise<PackageMapping | null> {
    // Build base filter
    const baseFilter: Record<string, unknown> = { resourceType: 'StructureMap' };
    if (options?.packageContext) {
      baseFilter.package = options.packageContext;
    }

    // Try URL first (most specific)
    try {
      const filter = { ...baseFilter, url: identifier };
      const structureMap = await this.packageExplorer.resolve(filter) as StructureMap;
      
      if (structureMap && isFumeMapping(structureMap)) {
        const expression = structureMapToExpression(structureMap);
        if (expression && structureMap.__packageId && structureMap.__packageVersion) {
          return {
            id: structureMap.id,
            expression,
            packageId: structureMap.__packageId,
            packageVersion: structureMap.__packageVersion,
            filename: structureMap.__filename as string,
            name: structureMap.name,
            url: structureMap.url
          };
        }
      }
    } catch (_error) {
      /* istanbul ignore next */
      // Not found or duplicate, try next
    }

    // Try ID
    try {
      const filter = { ...baseFilter, id: identifier };
      const structureMap = await this.packageExplorer.resolve(filter) as StructureMap;
      
      if (structureMap && isFumeMapping(structureMap)) {
        const expression = structureMapToExpression(structureMap);
        if (expression && structureMap.__packageId && structureMap.__packageVersion) {
          return {
            id: structureMap.id,
            expression,
            packageId: structureMap.__packageId,
            packageVersion: structureMap.__packageVersion,
            filename: structureMap.__filename as string,
            name: structureMap.name,
            url: structureMap.url
          };
        }
      }
    } catch (_error) {
      /* istanbul ignore next */
      // Not found or duplicate, try next
    }

    // Try name (least specific)
    try {
      const filter = { ...baseFilter, name: identifier };
      const structureMaps = await this.packageExplorer.lookup(filter);
      
      if (structureMaps && structureMaps.length > 0) {
        const structureMap = structureMaps[0] as StructureMap;
        
        if (isFumeMapping(structureMap)) {
          const expression = structureMapToExpression(structureMap);
          if (expression && structureMap.__packageId && structureMap.__packageVersion) {
            return {
              id: structureMap.id,
              expression,
              packageId: structureMap.__packageId,
              packageVersion: structureMap.__packageVersion,
              filename: structureMap.__filename as string,
              name: structureMap.name,
              url: structureMap.url
            };
          }
        }
      }
    } catch (_error) {
      /* istanbul ignore next */
      // Not found
    }

    return null;
  }
}

/**
 * Validate that a ConceptMap is a FUME alias resource
 * Must have the correct useContext
 */
function isFumeAliasResource(conceptMap: ConceptMap): boolean {
  if (!conceptMap.useContext || conceptMap.useContext.length === 0) {
    return false;
  }
  
  return conceptMap.useContext.some(
    ctx => ctx.code?.system === 'http://snomed.info/sct' &&
           ctx.code?.code === '706594005' &&
           ctx.valueCodeableConcept?.coding?.some(
             coding => coding.system === 'http://codes.fume.health' && coding.code === 'fume'
           )
  );
}

/**
 * Provider for aliases (server only)
 * Handles loading and transforming FUME alias ConceptMap resources
 */
export class AliasProvider {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private fhirClient: any | undefined,
    private logger?: Logger,
    private aliasResourceId?: string
  ) {}

  /**
   * Result of alias loading with metadata about the source ConceptMap.
   * @returns {{ aliases: AliasObject, resourceId?: string }} A promise that resolves to an object containing the resolved aliases
   * and the originating ConceptMap resource id, if available.
   */
  async loadAliasesWithMetadata(): Promise<{ aliases: AliasObject; resourceId?: string; meta?: { versionId?: string; lastUpdated?: string } }> {
    /* istanbul ignore if */
    if (!this.fhirClient) {
      return { aliases: {}, resourceId: undefined, meta: undefined };
    }
    
    try {
      const serverUrl = this.fhirClient.getBaseUrl();
      this.logger?.debug?.(`Loading aliases from FHIR server ${serverUrl}`);

      const configuredId = this.aliasResourceId?.trim();
      if (configuredId) {
        try {
          const conceptMap = await this.fhirClient.read('ConceptMap', configuredId, { noCache: true }) as ConceptMap;
          if (!conceptMap) {
            this.logger?.debug?.(`Alias ConceptMap '${configuredId}' not found on server`);
            return { aliases: {}, resourceId: undefined, meta: undefined };
          }

          const aliases = conceptMapToAliasObject(conceptMap, this.logger);
          this.logger?.debug?.(
            `Loaded ${Object.keys(aliases).length} alias(es) from server (ConceptMap id: ${conceptMap.id || configuredId})`
          );
          return {
            aliases,
            resourceId: conceptMap.id || configuredId,
            meta: {
              versionId: conceptMap.meta?.versionId,
              lastUpdated: conceptMap.meta?.lastUpdated
            }
          };
        } catch (error) {
          this.logger?.error?.(`Failed to load alias ConceptMap '${configuredId}' from server ${serverUrl}:`, error);
          return { aliases: {}, resourceId: undefined, meta: undefined };
        }
      }
      
      // Search for ConceptMap with name=FumeAliases and context parameter
      const searchParams = {
        name: 'FumeAliases',
        context: 'http://codes.fume.health|fume'
      };
      
      const resources = await this.fhirClient.search('ConceptMap', searchParams, { fetchAll: true, noCache: true });

      if (!resources || !Array.isArray(resources) || resources.length === 0) {
        this.logger?.debug?.('No alias ConceptMap found on server');
        return { aliases: {}, resourceId: undefined, meta: undefined };
      }
      
      // Filter client-side in case server ignores context parameter
      const aliasResources = resources.filter((cm: ConceptMap) => isFumeAliasResource(cm));
      
      if (aliasResources.length === 0) {
        this.logger?.debug?.('No alias ConceptMap with correct useContext found on server.');
        return { aliases: {}, resourceId: undefined, meta: undefined };
      }
      
      if (aliasResources.length > 1) {
        this.logger?.error?.(`Found ${aliasResources.length} alias ConceptMaps - expected exactly 1. Skipping alias loading from server.`);
        return { aliases: {}, resourceId: undefined, meta: undefined };
      }
      
      const conceptMap = aliasResources[0] as ConceptMap;
      const aliases = conceptMapToAliasObject(conceptMap, this.logger);

      // Keep AliasProvider logging lightweight; FumeMappingProvider logs the id on initialize/reload.
      this.logger?.debug?.(
        `Loaded ${Object.keys(aliases).length} alias(es) from server (ConceptMap id: ${conceptMap.id || 'unknown'})`
      );

      return {
        aliases,
        resourceId: conceptMap.id,
        meta: {
          versionId: conceptMap.meta?.versionId,
          lastUpdated: conceptMap.meta?.lastUpdated
        }
      };
      
    } catch (error) {
      /* istanbul ignore next */
      const serverUrl = this.fhirClient.getBaseUrl();
      /* istanbul ignore next */
      this.logger?.error?.(`Failed to load aliases from server ${serverUrl}:`, error);
      /* istanbul ignore next */
      return { aliases: {}, resourceId: undefined, meta: undefined };
    }
  }

  /**
   * Conditional read for a specific alias ConceptMap.
   */
  async conditionalReadAliases(
    resourceId: string,
    condition: { versionId?: string; lastUpdated?: string }
  ): Promise<{ status: number; aliases?: AliasObject; resourceId?: string; meta?: { versionId?: string; lastUpdated?: string } }> {
    /* istanbul ignore if */
    if (!this.fhirClient) {
      return { status: 0 };
    }

    try {
      const response = await this.fhirClient.conditionalRead('ConceptMap', resourceId, condition, { noCache: true });
      if (response.status === 200 && response.resource) {
        const conceptMap = response.resource as ConceptMap;
        const aliases = conceptMapToAliasObject(conceptMap, this.logger);
        return {
          status: 200,
          aliases,
          resourceId: conceptMap.id || resourceId,
          meta: {
            versionId: conceptMap.meta?.versionId,
            lastUpdated: conceptMap.meta?.lastUpdated
          }
        };
      }

      return { status: response.status };
    } catch (_error) {
      /* istanbul ignore next */
      return { status: 0 };
    }
  }

  /**
   * Load aliases from FHIR server
   * @returns AliasObject with all aliases, or empty object if none found
   */
  async loadAliases(): Promise<AliasObject> {
    const result = await this.loadAliasesWithMetadata();
    return result.aliases;
  }
}
