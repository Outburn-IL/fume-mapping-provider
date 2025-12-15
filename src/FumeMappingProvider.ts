import { FumeMappingProviderConfig, UserMapping, UserMappingMetadata, PackageMapping, PackageMappingMetadata, GetPackageMappingOptions } from './types';
import { Logger } from '@outburn/types';
import { UserMappingProvider, PackageMappingProvider } from './providers';

/**
 * Main orchestrator for FUME mappings from multiple sources
 * Separates user mappings (file + server) from package mappings
 */
export class FumeMappingProvider {
  private logger?: Logger;
  private userProvider?: UserMappingProvider;
  private packageProvider?: PackageMappingProvider;
  private userMappingsCache: Map<string, UserMapping> = new Map();

  constructor(private config: FumeMappingProviderConfig) {
    this.logger = config.logger;
    this.initializeProviders();
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
  }

  /**
   * Initialize all providers (load user mappings into cache)
   */
  async initialize(): Promise<void> {
    this.logger?.info?.('Initializing FUME Mapping Provider');
    
    if (this.userProvider) {
      this.logger?.info?.('Loading user mappings');
      this.userMappingsCache = await this.userProvider.loadMappings();
      this.logger?.info?.(`Loaded ${this.userMappingsCache.size} user mapping(s)`);
    }
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
   */
  async refreshUserMapping(key: string): Promise<UserMapping | null> {
    /* istanbul ignore if */
    if (!this.userProvider) {
      return null;
    }
    
    const mapping = await this.userProvider.refreshMapping(key);
    if (mapping) {
      this.userMappingsCache.set(key, mapping);
      this.logger?.debug?.(`Refreshed user mapping: ${key}`);
    } else {
      this.userMappingsCache.delete(key);
      this.logger?.debug?.(`User mapping no longer exists: ${key}`);
    }
    
    return mapping;
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
}
