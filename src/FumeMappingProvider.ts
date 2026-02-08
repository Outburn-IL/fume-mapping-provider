import { FumeMappingProviderConfig, UserMapping, UserMappingMetadata, PackageMapping, PackageMappingMetadata, GetPackageMappingOptions, AliasObject, AliasObjectWithMetadata, AliasWithMetadata, AliasSourceType, ConceptMap, StructureMap } from './types';
import { Logger } from '@outburn/types';
import { UserMappingProvider, PackageMappingProvider, AliasProvider } from './providers';
import { conceptMapToAliasObject, aliasObjectToConceptMap, structureMapToExpression, expressionToStructureMap } from './converters';
import { builtInAliases } from './builtInAliases';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Main orchestrator for FUME mappings from multiple sources
 * Separates user mappings (file + server) from package mappings
 */
export class FumeMappingProvider {
  private logger?: Logger;
  private userProvider?: UserMappingProvider;
  private packageProvider?: PackageMappingProvider;
  private aliasProvider?: AliasProvider;
  private userMappingsCache: Map<string, UserMapping> = new Map();
  private serverAliases: AliasObject = {};
  private fileAliases: AliasObject = {};
  private userRegisteredAliases: AliasObject = {};
  private aliasResourceId?: string;

  private aliasesCacheWithMetadata: Map<string, AliasWithMetadata> = new Map();

  private static readonly DEFAULT_CANONICAL_BASE_URL = 'http://example.com';
  private static readonly ALIASES_FILENAME = 'aliases.json';
  // Alias keys will be bound as JSONata variables; JSONata treats operators/whitespace as syntax.
  // Permit only characters that cannot be parsed as operators: letters, digits, underscore.
  // Allow leading '_' or digits (e.g. $1, $1b, $_private).
  private static readonly ALIAS_KEY_REGEX = /^[A-Za-z0-9_]+$/;

  constructor(private config: FumeMappingProviderConfig) {
    this.logger = config.logger;
    this.validateConfig();
    this.initializeProviders();
    this.rebuildAliasesCache();
  }

  private validateConfig(): void {
    if (!this.config.fileExtension) {
      return;
    }

    const ext = this.config.fileExtension.trim().toLowerCase();
    if (ext === '.json' || ext === 'json') {
      throw new Error(`Invalid fileExtension '${this.config.fileExtension}'. The '.json' extension is reserved (aliases.json).`);
    }
  }

  /**
   * Initialize providers based on configuration
   */
  private initializeProviders(): void {
    // User mapping provider (file + server)
    if (this.config.mappingsFolder || this.config.fhirClient) {
      this.logger?.info?.('Initializing user mapping provider');
      this.userProvider = new UserMappingProvider(
        this.config.mappingsFolder,
        this.config.fhirClient,
        this.logger,
        this.config.fileExtension
      );
    }

    // Package mapping provider
    if (this.config.packageExplorer) {
      this.logger?.info?.('Initializing package mapping provider');
      this.packageProvider = new PackageMappingProvider(
        this.config.packageExplorer,
        this.logger
      );
    }

    // Alias provider (server only)
    if (this.config.fhirClient) {
      this.logger?.info?.('Initializing alias provider');
      this.aliasProvider = new AliasProvider(
        this.config.fhirClient,
        this.logger,
        this.config.aliasConceptMapId
      );
    }
  }

  /**
   * Initialize all providers (load user mappings and aliases into cache)
   */
  async initialize(): Promise<void> {
    this.logger?.info?.('Initializing FUME Mapping Provider');
    
    if (this.userProvider) {
      this.logger?.info?.('Loading user mappings');
      this.userMappingsCache = await this.userProvider.loadMappings();
      this.logger?.info?.(`Loaded ${this.userMappingsCache.size} user mapping(s)`);
    }

    if (this.aliasProvider) {
      this.logger?.info?.('Loading aliases');

      const { aliases, resourceId } = await this.aliasProvider.loadAliasesWithMetadata();
      this.serverAliases = this.filterInvalidAliases(aliases, 'server');
      this.aliasResourceId = resourceId;

      this.logger?.info?.(
        `Loaded ${Object.keys(this.serverAliases).length} alias(es)` +
          (this.aliasResourceId ? ` (ConceptMap id: ${this.aliasResourceId})` : '')
      );
    }

    if (this.config.mappingsFolder) {
      this.logger?.info?.('Loading file aliases');
      this.fileAliases = await this.loadFileAliases();
      this.logger?.info?.(`Loaded ${Object.keys(this.fileAliases).length} file alias(es)`);
    }

    this.rebuildAliasesCache();
  }

  /**
   * Reload all user mappings
   */
  async reloadUserMappings(): Promise<void> {
    /* istanbul ignore if */
    if (!this.userProvider) {
      return;
    }
    
    this.logger?.info?.('Reloading user mappings');
    this.userMappingsCache = await this.userProvider.loadMappings();
    this.logger?.info?.(`Reloaded ${this.userMappingsCache.size} user mapping(s)`);
  }

  /**
   * Refresh a specific user mapping by key
   * @param key - The mapping key to refresh
   * @param mapping - Optional mapping to use directly (avoids server roundtrip)
   * @returns The refreshed mapping or null if not found
   */
  async refreshUserMapping(key: string, mapping?: UserMapping | null): Promise<UserMapping | null> {
    /* istanbul ignore if */
    if (!this.userProvider) {
      return null;
    }
    
    // If mapping provided, use it directly (optimistic update)
    if (mapping !== undefined) {
      if (mapping) {
        this.userMappingsCache.set(key, mapping);
        this.logger?.debug?.(`Updated user mapping cache with provided value: ${key}`);
      } else {
        this.userMappingsCache.delete(key);
        this.logger?.debug?.(`Removed user mapping from cache: ${key}`);
      }
      return mapping;
    }
    
    // Otherwise fetch from source
    const fetchedMapping = await this.userProvider.refreshMapping(key);
    if (fetchedMapping) {
      this.userMappingsCache.set(key, fetchedMapping);
      this.logger?.debug?.(`Refreshed user mapping: ${key}`);
    } else {
      this.userMappingsCache.delete(key);
      this.logger?.debug?.(`User mapping no longer exists: ${key}`);
    }
    
    return fetchedMapping;
  }

  // ========== USER MAPPING API ==========

  /**
   * Get all user mappings (lightning-fast - from cache)
   */
  getUserMappings(): UserMapping[] {
    return Array.from(this.userMappingsCache.values());
  }

  /**
   * Get all user mapping keys (lightning-fast - from cache)
   */
  getUserMappingKeys(): string[] {
    return Array.from(this.userMappingsCache.keys());
  }

  /**
   * Get user mapping metadata (lightning-fast - from cache)
   */
  getUserMappingsMetadata(): UserMappingMetadata[] {
    return this.getUserMappings().map(m => ({
      key: m.key,
      source: m.source,
      filename: m.filename,
      sourceServer: m.sourceServer,
      name: m.name,
      url: m.url
    }));
  }

  /**
   * Get a user mapping by key (lightning-fast - from cache)
   */
  getUserMapping(key: string): UserMapping | undefined {
    return this.userMappingsCache.get(key);
  }

  // ========== PACKAGE MAPPING API ==========

  /**
   * Get all package mappings
   * Always fresh from FPE (packages are immutable, FPE handles caching)
   */
  async getPackageMappings(options?: GetPackageMappingOptions): Promise<PackageMapping[]> {
    if (!this.packageProvider) {
      return [];
    }
    
    return await this.packageProvider.loadMappings(options);
  }

  /**
   * Get package mapping metadata
   */
  async getPackageMappingsMetadata(options?: GetPackageMappingOptions): Promise<PackageMappingMetadata[]> {
    const mappings = await this.getPackageMappings(options);
    return mappings.map(m => ({
      id: m.id,
      packageId: m.packageId,
      packageVersion: m.packageVersion,
      filename: m.filename,
      name: m.name,
      url: m.url
    }));
  }

  /**
   * Get a package mapping by identifier (tries url, id, name in order)
   */
  async getPackageMapping(identifier: string, options?: GetPackageMappingOptions): Promise<PackageMapping | null> {
    /* istanbul ignore if */
    if (!this.packageProvider) {
      return null;
    }
    
    return await this.packageProvider.getMapping(identifier, options);
  }

  // ========== ALIAS API ==========

  /**
   * Reload all aliases from server
   */
  async reloadAliases(): Promise<void> {
    this.logger?.info?.('Reloading aliases');

    if (this.aliasProvider) {
      const { aliases, resourceId } = await this.aliasProvider.loadAliasesWithMetadata();
      this.serverAliases = this.filterInvalidAliases(aliases, 'server');
      this.aliasResourceId = resourceId;

      this.logger?.info?.(
        `Reloaded ${Object.keys(this.serverAliases).length} server alias(es)` +
          (this.aliasResourceId ? ` (ConceptMap id: ${this.aliasResourceId})` : '')
      );
    }

    if (this.config.mappingsFolder) {
      this.fileAliases = await this.loadFileAliases();
      this.logger?.info?.(`Reloaded ${Object.keys(this.fileAliases).length} file alias(es)`);
    }

    this.rebuildAliasesCache();
  }

  /**
   * Get the ConceptMap resource id used for server aliases (if loaded).
   * Downstream consumers can use this id to update the alias ConceptMap.
   */
  getAliasResourceId(): string | undefined {
    return this.aliasResourceId;
  }

  /**
   * Register or update a single alias (optimistic cache update without server roundtrip)
   * @param name - The alias name/key
   * @param value - The alias value
   */
  registerAlias(name: string, value: string): void {
    this.userRegisteredAliases[name] = value;
    this.logger?.debug?.(`Registered alias: ${name}`);
    this.rebuildAliasesCache();
  }

  /**
   * Delete a specific alias from the cache
   * @param name - The alias name/key to delete
   */
  deleteAlias(name: string): void {
    // Always remove optimistic runtime override
    delete this.userRegisteredAliases[name];

    // Determine current resolved source (excluding local override which is now removed)
    const resolvedWithoutLocal = this.getResolvedAliasSourceType(name);

    // If file-sourced, remove file alias so server can be revealed.
    if (resolvedWithoutLocal === 'file') {
      delete this.fileAliases[name];
    } else if (resolvedWithoutLocal === 'server') {
      delete this.serverAliases[name];
    } else {
      // builtIn or not present: no-op
    }

    this.logger?.debug?.(`Deleted alias: ${name}`);
    this.rebuildAliasesCache();
  }

  /**
   * Get all cached aliases as a single object (lightning-fast - from cache)
   * @returns The alias object with all key-value mappings
   */
  getAliases(): AliasObject {
    const out: AliasObject = {};
    for (const [key, entry] of this.aliasesCacheWithMetadata.entries()) {
      out[key] = entry.value;
    }
    return out;
  }

  /**
   * Get all cached aliases with per-alias metadata (lightning-fast - from cache)
   */
  getAliasesWithMetadata(): AliasObjectWithMetadata {
    const out: AliasObjectWithMetadata = {};
    for (const [key, entry] of this.aliasesCacheWithMetadata.entries()) {
      out[key] = { ...entry };
    }
    return out;
  }

  private getResolvedAliasSourceType(name: string): AliasSourceType | undefined {
    // local overrides are handled outside this method
    if (this.fileAliases[name] !== undefined) {
      return 'file';
    }
    if (this.serverAliases[name] !== undefined) {
      return 'server';
    }
    if (builtInAliases[name] !== undefined) {
      return 'builtIn';
    }
    return undefined;
  }

  private getServerAliasSourceString(): string {
    const baseUrl = this.config.fhirClient?.getBaseUrl?.();
    const normalizedBase = (typeof baseUrl === 'string' ? baseUrl : '').replace(/\/$/, '');
    const id = this.aliasResourceId;
    if (normalizedBase && id) {
      return `${normalizedBase}/ConceptMap/${id}`;
    }
    if (normalizedBase) {
      return `${normalizedBase}/ConceptMap`;
    }
    return 'server';
  }

  private async loadFileAliases(): Promise<AliasObject> {
    if (!this.config.mappingsFolder) {
      return {};
    }

    const aliasesPath = path.resolve(this.config.mappingsFolder, FumeMappingProvider.ALIASES_FILENAME);

    try {
      await fs.stat(aliasesPath);
    } catch (_error) {
      // No aliases.json
      return {};
    }

    let raw: string;
    try {
      raw = await fs.readFile(aliasesPath, 'utf-8');
    } catch (error) {
      this.logger?.warn?.(`Failed to read ${aliasesPath}; ignoring file aliases. ${String(error)}`);
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.logger?.warn?.(`Invalid ${aliasesPath}: not valid JSON; ignoring file aliases. ${String(error)}`);
      return {};
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.logger?.warn?.(`Invalid ${aliasesPath}: expected a JSON object; ignoring file aliases.`);
      return {};
    }

    const result: AliasObject = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!FumeMappingProvider.ALIAS_KEY_REGEX.test(key)) {
        this.logger?.warn?.(
          `Invalid ${aliasesPath}: alias key '${key}' is invalid (must match ${FumeMappingProvider.ALIAS_KEY_REGEX}); skipping.`
        );
        continue;
      }
      if (typeof value !== 'string') {
        this.logger?.warn?.(`Invalid ${aliasesPath}: alias '${key}' must have a string value; skipping.`);
        continue;
      }
      result[key] = value;
    }

    return result;
  }

  private filterInvalidAliases(aliases: AliasObject, sourceLabel: 'server' | 'file'): AliasObject {
    const result: AliasObject = {};
    for (const [key, value] of Object.entries(aliases)) {
      if (!FumeMappingProvider.ALIAS_KEY_REGEX.test(key)) {
        this.logger?.warn?.(`Invalid ${sourceLabel} alias key '${key}' ignored (must match ${FumeMappingProvider.ALIAS_KEY_REGEX}).`);
        continue;
      }
      if (typeof value !== 'string') {
        this.logger?.warn?.(`Invalid ${sourceLabel} alias '${key}' ignored (value must be a string).`);
        continue;
      }
      result[key] = value;
    }
    return result;
  }

  private getFileAliasSourceString(): string {
    if (!this.config.mappingsFolder) {
      return 'file';
    }
    // Requirement: absolute path
    return path.resolve(this.config.mappingsFolder, FumeMappingProvider.ALIASES_FILENAME);
  }

  private rebuildAliasesCache(): void {
    const merged = new Map<string, AliasWithMetadata>();

    // Built-in
    for (const [key, value] of Object.entries(builtInAliases)) {
      merged.set(key, {
        value,
        sourceType: 'builtIn',
        source: 'builtIn'
      });
    }

    // Server (overrides built-in)
    const serverSource = this.getServerAliasSourceString();
    for (const [key, value] of Object.entries(this.serverAliases)) {
      merged.set(key, {
        value,
        sourceType: 'server',
        source: serverSource
      });
    }

    // File (overrides server; warn on collision)
    const fileSource = this.getFileAliasSourceString();
    for (const [key, value] of Object.entries(this.fileAliases)) {
      const existing = merged.get(key);
      if (existing?.sourceType === 'server') {
        this.logger?.warn?.(`File alias '${key}' overrides server alias with same key`);
      }
      merged.set(key, {
        value,
        sourceType: 'file',
        source: fileSource
      });
    }

    // Local optimistic overrides (highest priority)
    for (const [key, value] of Object.entries(this.userRegisteredAliases)) {
      merged.set(key, {
        value,
        sourceType: 'local',
        source: 'local'
      });
    }

    this.aliasesCacheWithMetadata = merged;
  }

  /**
   * Get the canonical base URL used for generating FHIR resources.
   * Defaults to 'http://example.com' if not provided.
   */
  getCanonicalBaseUrl(): string {
    return this.config.canonicalBaseUrl || FumeMappingProvider.DEFAULT_CANONICAL_BASE_URL;
  }

  // ========== CONVERTERS ==========

  /**
   * Transform a ConceptMap resource into an alias object
   * @param conceptMap - The ConceptMap resource
   * @returns An alias object with key-value mappings
   */
  conceptMapToAliasObject(conceptMap: ConceptMap): AliasObject {
    return conceptMapToAliasObject(conceptMap, this.logger);
  }

  /**
   * Transform an alias object into a ConceptMap resource
   * @param aliases - The alias object
   * @param existingConceptMap - Optional existing ConceptMap to update
   * @returns A ConceptMap resource
   */
  aliasObjectToConceptMap(
    aliases: AliasObject,
    existingConceptMap?: ConceptMap
  ): ConceptMap {
    return aliasObjectToConceptMap(aliases, this.getCanonicalBaseUrl(), existingConceptMap);
  }

  /**
   * Extract FUME expression from a StructureMap resource
   * @param structureMap - The StructureMap resource
   * @returns The FUME expression or null if not found
   */
  structureMapToExpression(structureMap: StructureMap): string | null {
    return structureMapToExpression(structureMap);
  }

  /**
   * Create a StructureMap resource from a FUME expression
   * @param mappingId - The mapping identifier
   * @param expression - The FUME expression
   * @returns A StructureMap resource
   */
  expressionToStructureMap(
    mappingId: string,
    expression: string
  ): StructureMap {
    return expressionToStructureMap(mappingId, expression, this.getCanonicalBaseUrl());
  }
}
