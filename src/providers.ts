import { UserMapping, PackageMapping, StructureMap, GetPackageMappingOptions, ConceptMap, AliasObject } from './types';
import { Logger } from '@outburn/types';
import { structureMapToExpression, conceptMapToAliasObject } from './converters';

/**
 * Validate that a StructureMap is a FUME mapping
 * Must have the correct useContext and fume expression extension
 */
function isFumeMapping(structureMap: StructureMap): boolean {
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
  
  constructor(
    private mappingsFolder: string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private fhirClient: any | undefined,
    private logger?: Logger,
    fileExtension?: string
  ) {
    this.fileExtension = fileExtension || '.fume';
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
    // Check file first
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

          mappings.set(key, {
            key,
            expression,
            source: 'file',
            filename: file
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

  private async loadFileMapping(key: string): Promise<UserMapping | null> {
    /* istanbul ignore if */
    if (!this.mappingsFolder) {
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
        source: 'file',
        filename
      };
    } catch (_error) {
      /* istanbul ignore next */
      // File not found
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
          
          const expression = structureMapToExpression(structureMap);

          if (expression) {
            mappings.set(structureMap.id, {
              key: structureMap.id,
              expression,
              source: 'server',
              sourceServer: serverUrl,
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
    
    try {
      const serverUrl = this.fhirClient.getBaseUrl();
      const structureMap = await this.fhirClient.read('StructureMap', key, { noCache: true }) as StructureMap;

      if (structureMap && isFumeMapping(structureMap)) {
        const expression = structureMapToExpression(structureMap);
        if (expression) {
          return {
            key: structureMap.id,
            expression,
            source: 'server',
            sourceServer: serverUrl,
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
    private logger?: Logger
  ) {}

  /**
   * Result of alias loading with metadata about the source ConceptMap.
   * @returns {{ aliases: AliasObject, resourceId?: string }} A promise that resolves to an object containing the resolved aliases
   * and the originating ConceptMap resource id, if available.
   */
  async loadAliasesWithMetadata(): Promise<{ aliases: AliasObject; resourceId?: string }> {
    /* istanbul ignore if */
    if (!this.fhirClient) {
      return { aliases: {}, resourceId: undefined };
    }
    
    try {
      const serverUrl = this.fhirClient.getBaseUrl();
      this.logger?.debug?.(`Loading aliases from FHIR server ${serverUrl}`);
      
      // Search for ConceptMap with name=FumeAliases and context parameter
      const searchParams = {
        name: 'FumeAliases',
        context: 'http://codes.fume.health|fume'
      };
      
      const resources = await this.fhirClient.search('ConceptMap', searchParams, { fetchAll: true, noCache: true });

      if (!resources || !Array.isArray(resources) || resources.length === 0) {
        this.logger?.debug?.('No alias ConceptMap found on server');
        return { aliases: {}, resourceId: undefined };
      }
      
      // Filter client-side in case server ignores context parameter
      const aliasResources = resources.filter((cm: ConceptMap) => isFumeAliasResource(cm));
      
      if (aliasResources.length === 0) {
        this.logger?.debug?.('No alias ConceptMap with correct useContext found');
        return { aliases: {}, resourceId: undefined };
      }
      
      if (aliasResources.length > 1) {
        this.logger?.error?.(`Found ${aliasResources.length} alias ConceptMaps - expected exactly 1. Skipping alias loading.`);
        return { aliases: {}, resourceId: undefined };
      }
      
      const conceptMap = aliasResources[0] as ConceptMap;
      const aliases = conceptMapToAliasObject(conceptMap, this.logger);

      // Keep AliasProvider logging lightweight; FumeMappingProvider logs the id on initialize/reload.
      this.logger?.debug?.(
        `Loaded ${Object.keys(aliases).length} alias(es) from server (ConceptMap id: ${conceptMap.id || 'unknown'})`
      );

      return { aliases, resourceId: conceptMap.id };
      
    } catch (error) {
      /* istanbul ignore next */
      const serverUrl = this.fhirClient.getBaseUrl();
      /* istanbul ignore next */
      this.logger?.error?.(`Failed to load aliases from server ${serverUrl}:`, error);
      /* istanbul ignore next */
      return { aliases: {}, resourceId: undefined };
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
