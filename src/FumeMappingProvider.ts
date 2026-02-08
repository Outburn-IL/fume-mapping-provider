import { FumeMappingProviderConfig, UserMapping, UserMappingMetadata, PackageMapping, PackageMappingMetadata, GetPackageMappingOptions, AliasObject, AliasObjectWithMetadata, AliasWithMetadata, ConceptMap, StructureMap } from './types';
import { Logger } from '@outburn/types';
import { UserMappingProvider, PackageMappingProvider, AliasProvider } from './providers';
import { conceptMapToAliasObject, aliasObjectToConceptMap, structureMapToExpression, expressionToStructureMap } from './converters';
import { builtInAliases } from './builtInAliases';
import * as fs from 'fs/promises';
import type { Stats } from 'fs';
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
  private aliasResourceId?: string;
  private aliasResourceMeta?: { versionId?: string; lastUpdated?: string };
  private serverMappingsMeta: Map<string, { versionId?: string; lastUpdated?: string }> = new Map();
  private jsonMappingRawCache: Map<string, string> = new Map();
  private filePollingState: Map<string, { mtimeMs: number; size: number; key: string; isJson: boolean; isAliasFile: boolean }>
    = new Map();
  private filePollingTimer?: NodeJS.Timeout;
  private serverPollingTimer?: NodeJS.Timeout;
  private forcedResyncTimer?: NodeJS.Timeout;
  private filePollInProgress = false;
  private serverPollInProgress = false;
  private resyncInProgress = false;
  private lastServerPollAt?: string;

  private aliasesCacheWithMetadata: Map<string, AliasWithMetadata> = new Map();

  private static readonly DEFAULT_CANONICAL_BASE_URL = 'http://example.com';
  private static readonly ALIASES_FILENAME = 'aliases.json';
  private static readonly DEFAULT_FILE_POLLING_INTERVAL_MS = 5000;
  private static readonly DEFAULT_SERVER_POLLING_INTERVAL_MS = 30000;
  private static readonly DEFAULT_FORCED_RESYNC_INTERVAL_MS = 60 * 60 * 1000;
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
    
    await this.refreshUserMappingsFromSources('initialize');
    await this.refreshAliasesFromSources('initialize');
    await this.primeFilePollingState();

    this.lastServerPollAt = new Date().toISOString();
    this.startAutomaticChangeTracking();
  }

  /**
   * Reload all user mappings
   */
  async reloadUserMappings(): Promise<void> {
    /* istanbul ignore if */
    if (!this.userProvider) {
      return;
    }

    await this.refreshUserMappingsFromSources('manual');
  }

  /**
   * Refresh a specific user mapping by key
   * @param key - The mapping key to refresh
   * @returns The refreshed mapping or null if not found
   */
  async refreshUserMapping(key: string): Promise<UserMapping | null> {
    /* istanbul ignore if */
    if (!this.userProvider) {
      return null;
    }

    // File-based sources take precedence
    if (this.config.mappingsFolder) {
      const jsonMapping = await this.userProvider.loadJsonFileMapping(key);
      if (jsonMapping) {
        const raw = await this.userProvider.readJsonFileRaw(key);
        this.applySingleMappingUpdate(key, jsonMapping, raw ?? undefined);
        return jsonMapping;
      }

      const fileMapping = await this.userProvider.loadFileMapping(key);
      if (fileMapping) {
        this.applySingleMappingUpdate(key, fileMapping);
        return fileMapping;
      }
    }

    if (!this.config.fhirClient) {
      this.userMappingsCache.delete(key);
      this.jsonMappingRawCache.delete(key);
      this.serverMappingsMeta.delete(key);
      this.logger?.debug?.(`User mapping no longer exists: ${key}`);
      return null;
    }

    // Server-backed source (conditional read)
    if (this.config.fhirClient) {
      const condition = this.serverMappingsMeta.get(key) || {};
      const response = await this.userProvider.conditionalReadServerMapping(key, condition);

      if (response.status === 304) {
        return this.userMappingsCache.get(key) || null;
      }

      if (response.status === 200) {
        if (response.mapping) {
          if (response.meta) {
            this.serverMappingsMeta.set(key, response.meta);
          }
          this.applySingleMappingUpdate(key, response.mapping);
          return response.mapping;
        }

        this.userMappingsCache.delete(key);
        this.jsonMappingRawCache.delete(key);
        this.serverMappingsMeta.delete(key);
        this.logger?.debug?.(`User mapping no longer exists or is not a FUME mapping: ${key}`);
        return null;
      }

      if (response.status === 404 || response.status === 410) {
        this.userMappingsCache.delete(key);
        this.jsonMappingRawCache.delete(key);
        this.serverMappingsMeta.delete(key);
        this.logger?.debug?.(`User mapping deleted on server: ${key}`);
        return null;
      }
    }

    return this.userMappingsCache.get(key) || null;
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
      sourceType: m.sourceType,
      source: m.source,
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
    await this.refreshAliasesFromSources('manual');
  }

  /**
   * Start automatic change tracking (polling + forced resync).
   */
  startAutomaticChangeTracking(): void {
    this.stopAutomaticChangeTracking();

    const fileInterval = this.resolveInterval(
      this.config.filePollingIntervalMs,
      FumeMappingProvider.DEFAULT_FILE_POLLING_INTERVAL_MS
    );
    const serverInterval = this.resolveInterval(
      this.config.serverPollingIntervalMs,
      FumeMappingProvider.DEFAULT_SERVER_POLLING_INTERVAL_MS
    );
    const resyncInterval = this.resolveInterval(
      this.config.forcedResyncIntervalMs,
      FumeMappingProvider.DEFAULT_FORCED_RESYNC_INTERVAL_MS
    );

    if (fileInterval > 0 && this.config.mappingsFolder) {
      this.filePollingTimer = setInterval(() => {
        void this.pollFileMappings();
      }, fileInterval);
      this.filePollingTimer.unref?.();
    }

    if (serverInterval > 0 && this.config.fhirClient) {
      this.serverPollingTimer = setInterval(() => {
        void this.pollServerResources();
      }, serverInterval);
      this.serverPollingTimer.unref?.();
    }

    if (resyncInterval > 0) {
      this.forcedResyncTimer = setInterval(() => {
        void this.forcedResync();
      }, resyncInterval);
      this.forcedResyncTimer.unref?.();
    }
  }

  /**
   * Stop automatic change tracking.
   */
  stopAutomaticChangeTracking(): void {
    if (this.filePollingTimer) {
      clearInterval(this.filePollingTimer);
      this.filePollingTimer = undefined;
    }
    if (this.serverPollingTimer) {
      clearInterval(this.serverPollingTimer);
      this.serverPollingTimer = undefined;
    }
    if (this.forcedResyncTimer) {
      clearInterval(this.forcedResyncTimer);
      this.forcedResyncTimer = undefined;
    }
  }

  private resolveInterval(value: number | undefined, defaultValue: number): number {
    if (value === undefined || value === null) {
      return defaultValue;
    }
    return value;
  }

  private async refreshUserMappingsFromSources(trigger: 'initialize' | 'manual' | 'resync'): Promise<void> {
    /* istanbul ignore if */
    if (!this.userProvider) {
      return;
    }

    this.logger?.info?.(
      `${trigger === 'initialize' ? 'Loading' : 'Reloading'} user mappings from sources`
    );

    const mappings = await this.userProvider.loadMappings();
    const jsonRawByKey = await this.readJsonRawForMappings(mappings);
    this.applyMappingsIncrementally(mappings, jsonRawByKey);

    this.logger?.info?.(`Loaded ${this.userMappingsCache.size} user mapping(s)`);
  }

  private async refreshAliasesFromSources(trigger: 'initialize' | 'manual' | 'resync'): Promise<void> {
    this.logger?.info?.(
      `${trigger === 'initialize' ? 'Loading' : 'Reloading'} aliases from sources`
    );

    if (this.aliasProvider) {
      const { aliases, resourceId, meta } = await this.aliasProvider.loadAliasesWithMetadata();
      this.serverAliases = this.filterInvalidAliases(aliases, 'server');
      this.aliasResourceId = resourceId;
      this.aliasResourceMeta = meta;

      this.logger?.info?.(
        `Loaded ${Object.keys(this.serverAliases).length} server alias(es)` +
          (this.aliasResourceId ? ` (ConceptMap id: ${this.aliasResourceId})` : '')
      );
    }

    if (this.config.mappingsFolder) {
      this.fileAliases = await this.loadFileAliases();
      this.logger?.info?.(`Loaded ${Object.keys(this.fileAliases).length} file alias(es)`);
    }

    this.rebuildAliasesCacheIfChanged();
  }

  private rebuildAliasesCacheIfChanged(): void {
    const nextCache = this.buildAliasesCache(false);
    if (this.areAliasCachesEqual(this.aliasesCacheWithMetadata, nextCache)) {
      return;
    }

    this.aliasesCacheWithMetadata = this.buildAliasesCache(true);
  }

  private areAliasCachesEqual(
    a: Map<string, AliasWithMetadata>,
    b: Map<string, AliasWithMetadata>
  ): boolean {
    if (a.size !== b.size) {
      return false;
    }
    for (const [key, entry] of a.entries()) {
      const other = b.get(key);
      if (!other) {
        return false;
      }
      if (entry.value !== other.value) {
        return false;
      }
      if (entry.sourceType !== other.sourceType) {
        return false;
      }
      if (entry.source !== other.source) {
        return false;
      }
    }
    return true;
  }

  private isJsonFileMapping(mapping: UserMapping): boolean {
    return mapping.sourceType === 'file' && mapping.source.toLowerCase().endsWith('.json');
  }

  private mappingsEquivalent(
    existing: UserMapping,
    incoming: UserMapping,
    incomingJsonRaw?: string
  ): boolean {
    if (existing.sourceType !== incoming.sourceType) {
      return false;
    }
    if (existing.source !== incoming.source) {
      return false;
    }
    if (existing.name !== incoming.name) {
      return false;
    }
    if (existing.url !== incoming.url) {
      return false;
    }

    if (this.isJsonFileMapping(incoming)) {
      const existingRaw = this.jsonMappingRawCache.get(existing.key);
      if (existingRaw === undefined || incomingJsonRaw === undefined) {
        return false;
      }
      return existingRaw === incomingJsonRaw;
    }

    return existing.expression === incoming.expression;
  }

  private applySingleMappingUpdate(key: string, mapping: UserMapping, jsonRaw?: string): void {
    const existing = this.userMappingsCache.get(key);
    const shouldUpdate = !existing || !this.mappingsEquivalent(existing, mapping, jsonRaw);

    if (shouldUpdate) {
      this.userMappingsCache.set(key, mapping);
      this.logger?.debug?.(`Updated user mapping: ${key}`);
    }

    if (this.isJsonFileMapping(mapping)) {
      if (jsonRaw !== undefined) {
        this.jsonMappingRawCache.set(key, jsonRaw);
      }
    } else {
      this.jsonMappingRawCache.delete(key);
    }
  }

  private applyMappingsIncrementally(
    mappings: Map<string, UserMapping>,
    jsonRawByKey: Map<string, string>
  ): void {
    for (const [key, mapping] of mappings.entries()) {
      const jsonRaw = jsonRawByKey.get(key);
      this.applySingleMappingUpdate(key, mapping, jsonRaw);
    }

    for (const key of Array.from(this.userMappingsCache.keys())) {
      if (!mappings.has(key)) {
        this.userMappingsCache.delete(key);
        this.jsonMappingRawCache.delete(key);
        this.serverMappingsMeta.delete(key);
        this.logger?.debug?.(`Removed user mapping from cache: ${key}`);
      }
    }
  }

  private async readJsonRawForMappings(mappings: Map<string, UserMapping>): Promise<Map<string, string>> {
    const rawByKey = new Map<string, string>();

    if (!this.userProvider) {
      return rawByKey;
    }

    for (const [key, mapping] of mappings.entries()) {
      if (this.isJsonFileMapping(mapping)) {
        const raw = await this.userProvider.readJsonFileRaw(key);
        if (raw !== null) {
          rawByKey.set(key, raw);
        }
      }
    }

    return rawByKey;
  }

  private async primeFilePollingState(): Promise<void> {
    if (!this.config.mappingsFolder || !this.userProvider) {
      return;
    }

    try {
      const entries = await fs.readdir(this.config.mappingsFolder);
      this.filePollingState.clear();

      for (const file of entries) {
        const filePath = path.join(this.config.mappingsFolder, file);
        const isAliasFile = file.toLowerCase() === FumeMappingProvider.ALIASES_FILENAME;
        const isJson = file.toLowerCase().endsWith('.json') && !isAliasFile;
        const isMappingFile = file.endsWith(this.config.fileExtension || '.fume');

        if (!isAliasFile && !isJson && !isMappingFile) {
          continue;
        }

        const key = isAliasFile
          ? 'aliases'
          : path.basename(file, isJson ? '.json' : (this.config.fileExtension || '.fume'));

        if (isJson && !this.userProvider.isValidJsonMappingKey(key)) {
          continue;
        }

        if (isMappingFile && !this.userProvider.isValidFileMappingKeyForPolling(key)) {
          continue;
        }

        const stat = await fs.stat(filePath);
        this.filePollingState.set(filePath, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          key,
          isJson,
          isAliasFile
        });

        if (isJson && key) {
          const raw = await this.userProvider.readJsonFileRaw(key);
          if (raw !== null) {
            this.jsonMappingRawCache.set(key, raw);
          }
        }
      }
    } catch (_error) {
      // ignore
    }
  }

  private async pollFileMappings(): Promise<void> {
    if (this.filePollInProgress || !this.config.mappingsFolder || !this.userProvider) {
      return;
    }

    this.filePollInProgress = true;
    try {
      const entries = await fs.readdir(this.config.mappingsFolder);
      const currentFiles = new Map<string, { key: string; isJson: boolean; isAliasFile: boolean }>();

      for (const file of entries) {
        const filePath = path.join(this.config.mappingsFolder, file);
        const isAliasFile = file.toLowerCase() === FumeMappingProvider.ALIASES_FILENAME;
        const isJson = file.toLowerCase().endsWith('.json') && !isAliasFile;
        const isMappingFile = file.endsWith(this.config.fileExtension || '.fume');

        if (!isAliasFile && !isJson && !isMappingFile) {
          continue;
        }

        const key = isAliasFile
          ? 'aliases'
          : path.basename(file, isJson ? '.json' : (this.config.fileExtension || '.fume'));

        if (isJson && !this.userProvider.isValidJsonMappingKey(key)) {
          continue;
        }

        if (isMappingFile && !this.userProvider.isValidFileMappingKeyForPolling(key)) {
          continue;
        }

        currentFiles.set(filePath, { key, isJson, isAliasFile });

        let stat: Stats;
        try {
          stat = await fs.stat(filePath);
        } catch (_error) {
          continue;
        }

        const prev = this.filePollingState.get(filePath);
        if (!prev || prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size) {
          if (isAliasFile) {
            await this.refreshAliasesFromSources('manual');
          } else if (isJson) {
            const raw = await this.userProvider.readJsonFileRaw(key);
            const prevRaw = this.jsonMappingRawCache.get(key);
            if (raw !== null && raw !== prevRaw) {
              this.jsonMappingRawCache.set(key, raw);
              await this.refreshUserMapping(key);
            }
          } else if (isMappingFile) {
            const fileMapping = await this.userProvider.loadFileMapping(key);
            if (fileMapping) {
              const existing = this.userMappingsCache.get(key);
              if (!existing || !this.mappingsEquivalent(existing, fileMapping)) {
                this.applySingleMappingUpdate(key, fileMapping);
              }
            } else {
              await this.refreshUserMapping(key);
            }
          }

          this.filePollingState.set(filePath, {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            key,
            isJson,
            isAliasFile
          });
        }
      }

      // Detect deletions
      for (const [filePath, prev] of Array.from(this.filePollingState.entries())) {
        if (!currentFiles.has(filePath)) {
          this.filePollingState.delete(filePath);
          if (prev.isAliasFile) {
            await this.refreshAliasesFromSources('manual');
          } else {
            await this.refreshUserMapping(prev.key);
            this.jsonMappingRawCache.delete(prev.key);
          }
        }
      }
    } finally {
      this.filePollInProgress = false;
    }
  }

  private async pollServerResources(): Promise<void> {
    if (this.serverPollInProgress) {
      return;
    }

    this.serverPollInProgress = true;
    const pollStart = new Date().toISOString();
    try {
      if (this.aliasProvider) {
        if (this.aliasResourceId) {
          const response = await this.aliasProvider.conditionalReadAliases(
            this.aliasResourceId,
            this.aliasResourceMeta || {}
          );

          if (response.status === 200 && response.aliases) {
            this.serverAliases = this.filterInvalidAliases(response.aliases, 'server');
            this.aliasResourceId = response.resourceId || this.aliasResourceId;
            this.aliasResourceMeta = response.meta;
            this.rebuildAliasesCacheIfChanged();
          } else if (response.status === 404 || response.status === 410) {
            if (!this.config.aliasConceptMapId) {
              this.aliasResourceId = undefined;
              this.aliasResourceMeta = undefined;
            }
            await this.refreshAliasesFromSources('manual');
          }
        } else {
          await this.refreshAliasesFromSources('manual');
        }
      }

      if (this.userProvider && this.config.fhirClient) {
        const { mappings, metaByKey } = await this.userProvider.searchServerMappings(this.lastServerPollAt);
        for (const [key, mapping] of mappings.entries()) {
          const meta = metaByKey.get(key);
          if (meta) {
            this.serverMappingsMeta.set(key, meta);
          }
          this.applySingleMappingUpdate(key, mapping);
        }
      }

      this.lastServerPollAt = pollStart;
    } finally {
      this.serverPollInProgress = false;
    }
  }

  private async forcedResync(): Promise<void> {
    if (this.resyncInProgress) {
      return;
    }

    this.resyncInProgress = true;
    try {
      await this.refreshUserMappingsFromSources('resync');
      await this.refreshAliasesFromSources('resync');
      await this.primeFilePollingState();
    } finally {
      this.resyncInProgress = false;
    }
  }

  /**
   * Get the ConceptMap resource id used for server aliases (if loaded).
   * Downstream consumers can use this id to update the alias ConceptMap.
   */
  getAliasResourceId(): string | undefined {
    return this.aliasResourceId;
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
    this.aliasesCacheWithMetadata = this.buildAliasesCache(true);
  }

  private buildAliasesCache(logCollisions: boolean): Map<string, AliasWithMetadata> {
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
        if (logCollisions) {
          this.logger?.warn?.(`File alias '${key}' overrides server alias with same key`);
        }
      }
      merged.set(key, {
        value,
        sourceType: 'file',
        source: fileSource
      });
    }

    return merged;
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
