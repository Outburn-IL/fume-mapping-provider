import { FhirPackageExplorer } from 'fhir-package-explorer';
import { FhirClient } from '@outburn/fhir-client';
import { FumeMappingProvider } from '../../src/FumeMappingProvider';
import { UserMappingProvider, PackageMappingProvider } from '../../src/providers';
import { StructureMap, ConceptMap } from '../../src/types';
import { builtInAliases } from '../../src/builtInAliases';

// Mock the providers
jest.mock('../../src/providers');

describe('FumeMappingProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize user provider when file or client config provided', () => {
      const mockClient = new FhirClient({ baseUrl: 'http://test.com', fhirVersion: 'R4' });
      
      new FumeMappingProvider({
        mappingsFolder: '/test/mappings',
        fhirClient: mockClient
      });

      expect(UserMappingProvider).toHaveBeenCalledWith(
        '/test/mappings',
        mockClient,
        undefined,
        undefined
      );
    });

    it('should initialize package provider when explorer provided', () => {
      const mockExplorer = { lookup: jest.fn() } as unknown as FhirPackageExplorer;
      
      new FumeMappingProvider({
        packageExplorer: mockExplorer
      });

      expect(PackageMappingProvider).toHaveBeenCalledWith(
        mockExplorer,
        undefined
      );
    });

    it('should pass custom file extension to user provider', () => {
      new FumeMappingProvider({
        mappingsFolder: '/test/mappings',
        fileExtension: '.txt'
      });

      expect(UserMappingProvider).toHaveBeenCalledWith(
        '/test/mappings',
        undefined,
        undefined,
        '.txt'
      );
    });

    it('should pass logger to providers', () => {
      const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const mockExplorer = { lookup: jest.fn() } as unknown as FhirPackageExplorer;
      
      new FumeMappingProvider({
        packageExplorer: mockExplorer,
        mappingsFolder: '/test/mappings',
        logger: mockLogger
      });

      expect(UserMappingProvider).toHaveBeenCalledWith(
        '/test/mappings',
        undefined,
        mockLogger,
        undefined
      );
      expect(PackageMappingProvider).toHaveBeenCalledWith(
        mockExplorer,
        mockLogger
      );
    });
  });

  describe('User Mappings', () => {
    let provider: FumeMappingProvider;
    let mockUserProvider: {
      loadMappings: jest.Mock;
      refreshMapping: jest.Mock;
    };

    beforeEach(() => {
      mockUserProvider = {
        loadMappings: jest.fn(),
        refreshMapping: jest.fn()
      };

      (UserMappingProvider as jest.Mock).mockImplementation(() => mockUserProvider);

      provider = new FumeMappingProvider({
        mappingsFolder: '/test/mappings'
      });
    });

    it('should load user mappings on initialize', async () => {
      const mockMappings = new Map([
        ['map1', { key: 'map1', expression: 'expr1', source: 'file' as const, filename: 'map1.fume' }],
        ['map2', { key: 'map2', expression: 'expr2', source: 'server' as const, sourceServer: 'http://test.com' }]
      ]);

      mockUserProvider.loadMappings.mockResolvedValue(mockMappings);

      await provider.initialize();

      expect(mockUserProvider.loadMappings).toHaveBeenCalled();
      expect(provider.getUserMappings()).toHaveLength(2);
      expect(provider.getUserMappingKeys()).toEqual(['map1', 'map2']);
    });

    it('should get user mapping by key', async () => {
      const mockMappings = new Map([
        ['test-key', { key: 'test-key', expression: 'test-expr', source: 'file' as const, filename: 'test.fume' }]
      ]);

      mockUserProvider.loadMappings.mockResolvedValue(mockMappings);

      await provider.initialize();

      const mapping = provider.getUserMapping('test-key');
      expect(mapping).toBeDefined();
      expect(mapping?.expression).toBe('test-expr');
    });

    it('should return undefined for non-existent key', async () => {
      mockUserProvider.loadMappings.mockResolvedValue(new Map());

      await provider.initialize();

      const mapping = provider.getUserMapping('non-existent');
      expect(mapping).toBeUndefined();
    });

    it('should reload user mappings', async () => {
      const initialMappings = new Map([
        ['map1', { key: 'map1', expression: 'expr1', source: 'file' as const, filename: 'map1.fume' }]
      ]);

      const reloadedMappings = new Map([
        ['map1', { key: 'map1', expression: 'expr1-updated', source: 'file' as const, filename: 'map1.fume' }],
        ['map2', { key: 'map2', expression: 'expr2', source: 'file' as const, filename: 'map2.fume' }]
      ]);

      mockUserProvider.loadMappings
        .mockResolvedValueOnce(initialMappings)
        .mockResolvedValueOnce(reloadedMappings);

      await provider.initialize();
      expect(provider.getUserMappings()).toHaveLength(1);

      await provider.reloadUserMappings();
      expect(provider.getUserMappings()).toHaveLength(2);
      expect(provider.getUserMapping('map1')?.expression).toBe('expr1-updated');
    });

    it('should refresh specific user mapping', async () => {
      const initialMappings = new Map([
        ['refresh-test', { key: 'refresh-test', expression: 'old', source: 'file' as const, filename: 'test.fume' }]
      ]);

      mockUserProvider.loadMappings.mockResolvedValue(initialMappings);
      mockUserProvider.refreshMapping.mockResolvedValue({
        key: 'refresh-test',
        expression: 'new',
        source: 'file',
        filename: 'test.fume'
      });

      await provider.initialize();
      expect(provider.getUserMapping('refresh-test')?.expression).toBe('old');

      await provider.refreshUserMapping('refresh-test');
      expect(provider.getUserMapping('refresh-test')?.expression).toBe('new');
    });

    it('should remove mapping from cache when refresh returns null', async () => {
      const initialMappings = new Map([
        ['deleted-map', { key: 'deleted-map', expression: 'expr', source: 'file' as const, filename: 'test.fume' }]
      ]);

      mockUserProvider.loadMappings.mockResolvedValue(initialMappings);
      mockUserProvider.refreshMapping.mockResolvedValue(null);

      await provider.initialize();
      expect(provider.getUserMapping('deleted-map')).toBeDefined();

      await provider.refreshUserMapping('deleted-map');
      expect(provider.getUserMapping('deleted-map')).toBeUndefined();
    });

    it('should update cache directly when mapping provided (optimistic update)', async () => {
      const initialMappings = new Map([
        ['optimistic-test', { key: 'optimistic-test', expression: 'old', source: 'server' as const, sourceServer: 'http://test.com' }]
      ]);

      mockUserProvider.loadMappings.mockResolvedValue(initialMappings);

      await provider.initialize();
      expect(provider.getUserMapping('optimistic-test')?.expression).toBe('old');

      // Update with provided mapping (no server roundtrip)
      const updatedMapping = {
        key: 'optimistic-test',
        expression: 'new-from-client',
        source: 'server' as const,
        sourceServer: 'http://test.com'
      };

      const result = await provider.refreshUserMapping('optimistic-test', updatedMapping);
      
      expect(result).toEqual(updatedMapping);
      expect(provider.getUserMapping('optimistic-test')?.expression).toBe('new-from-client');
      expect(mockUserProvider.refreshMapping).not.toHaveBeenCalled();
    });

    it('should remove mapping when null provided as optimistic update', async () => {
      const initialMappings = new Map([
        ['to-delete', { key: 'to-delete', expression: 'expr', source: 'server' as const, sourceServer: 'http://test.com' }]
      ]);

      mockUserProvider.loadMappings.mockResolvedValue(initialMappings);

      await provider.initialize();
      expect(provider.getUserMapping('to-delete')).toBeDefined();

      // Delete with null (optimistic deletion)
      const result = await provider.refreshUserMapping('to-delete', null);
      
      expect(result).toBeNull();
      expect(provider.getUserMapping('to-delete')).toBeUndefined();
      expect(mockUserProvider.refreshMapping).not.toHaveBeenCalled();
    });

    it('should get user mappings metadata without expressions', async () => {
      const mockMappings = new Map([
        ['map1', { 
          key: 'map1', 
          expression: 'long expression here', 
          source: 'file' as const, 
          filename: 'map1.fume',
          name: 'Map1',
          url: 'http://test.com/map1'
        }]
      ]);

      mockUserProvider.loadMappings.mockResolvedValue(mockMappings);

      await provider.initialize();

      const metadata = provider.getUserMappingsMetadata();
      expect(metadata).toHaveLength(1);
      expect(metadata[0]).not.toHaveProperty('expression');
      expect(metadata[0]).toHaveProperty('key');
      expect(metadata[0]).toHaveProperty('source');
      expect(metadata[0]).toHaveProperty('filename');
      expect(metadata[0]).toHaveProperty('name');
      expect(metadata[0]).toHaveProperty('url');
    });
  });

  describe('Package Mappings', () => {
    let provider: FumeMappingProvider;
    let mockPackageProvider: {
      loadMappings: jest.Mock;
      getMapping: jest.Mock;
    };

    beforeEach(() => {
      mockPackageProvider = {
        loadMappings: jest.fn(),
        getMapping: jest.fn()
      };

      (PackageMappingProvider as jest.Mock).mockImplementation(() => mockPackageProvider);

      const mockExplorer = { lookup: jest.fn() } as unknown as FhirPackageExplorer;
      provider = new FumeMappingProvider({
        packageExplorer: mockExplorer
      });
    });

    it('should get package mappings', async () => {
      const mockMappings = [
        {
          id: 'pkg-map1',
          expression: 'expr1',
          packageId: 'test.pkg',
          packageVersion: '1.0.0',
          filename: 'map1.json',
          name: 'PkgMap1',
          url: 'http://test.com/pkg/map1'
        }
      ];

      mockPackageProvider.loadMappings.mockResolvedValue(mockMappings);

      const mappings = await provider.getPackageMappings();
      expect(mappings).toEqual(mockMappings);
      expect(mockPackageProvider.loadMappings).toHaveBeenCalledWith(undefined);
    });

    it('should get package mappings with filter options', async () => {
      const mockMappings = [
        {
          id: 'pkg-map1',
          expression: 'expr1',
          packageId: 'test.pkg',
          packageVersion: '1.0.0',
          filename: 'map1.json'
        }
      ];

      mockPackageProvider.loadMappings.mockResolvedValue(mockMappings);

      const options = { packageContext: 'test.pkg@1.0.0' };
      const mappings = await provider.getPackageMappings(options);
      
      expect(mappings).toEqual(mockMappings);
      expect(mockPackageProvider.loadMappings).toHaveBeenCalledWith(options);
    });

    it('should get package mapping by identifier', async () => {
      const mockMapping = {
        id: 'test-map',
        expression: 'expr',
        packageId: 'test.pkg',
        packageVersion: '1.0.0',
        filename: 'test.json'
      };

      mockPackageProvider.getMapping.mockResolvedValue(mockMapping);

      const mapping = await provider.getPackageMapping('test-identifier');
      
      expect(mapping).toEqual(mockMapping);
      expect(mockPackageProvider.getMapping).toHaveBeenCalledWith('test-identifier', undefined);
    });

    it('should get package mapping with filter options', async () => {
      const mockMapping = {
        id: 'test-map',
        expression: 'expr',
        packageId: 'test.pkg',
        packageVersion: '1.0.0',
        filename: 'test.json'
      };

      mockPackageProvider.getMapping.mockResolvedValue(mockMapping);

      const options = { packageContext: 'test.pkg@1.0.0' };
      const mapping = await provider.getPackageMapping('test-identifier', options);
      
      expect(mapping).toEqual(mockMapping);
      expect(mockPackageProvider.getMapping).toHaveBeenCalledWith('test-identifier', options);
    });

    it('should return null when package mapping not found', async () => {
      mockPackageProvider.getMapping.mockResolvedValue(null);

      const mapping = await provider.getPackageMapping('non-existent');
      expect(mapping).toBeNull();
    });

    it('should get package mappings metadata without expressions', async () => {
      const mockMappings = [
        {
          id: 'map1',
          expression: 'long expression here',
          packageId: 'test.pkg',
          packageVersion: '1.0.0',
          filename: 'map1.json',
          name: 'Map1',
          url: 'http://test.com/map1'
        }
      ];

      mockPackageProvider.loadMappings.mockResolvedValue(mockMappings);

      const metadata = await provider.getPackageMappingsMetadata();
      expect(metadata).toHaveLength(1);
      expect(metadata[0]).not.toHaveProperty('expression');
      expect(metadata[0]).toHaveProperty('id');
      expect(metadata[0]).toHaveProperty('packageId');
      expect(metadata[0]).toHaveProperty('packageVersion');
      expect(metadata[0]).toHaveProperty('filename');
    });

    it('should return empty array when no package provider', async () => {
      const providerWithoutPackages = new FumeMappingProvider({
        mappingsFolder: '/test/mappings'
      });

      const mappings = await providerWithoutPackages.getPackageMappings();
      expect(mappings).toEqual([]);
    });
  });

  describe('Aliases', () => {
    let provider: FumeMappingProvider;
    let mockClient: FhirClient;
    let mockAliasProvider: {
      loadAliases: jest.Mock;
    };

    beforeEach(() => {
      mockClient = new FhirClient({ baseUrl: 'http://test.com', fhirVersion: 'R4' });
      
      mockAliasProvider = {
        loadAliases: jest.fn()
      };

      // Mock the AliasProvider module
      const providersModule = require('../../src/providers');
      providersModule.AliasProvider = jest.fn().mockImplementation(() => mockAliasProvider);

      provider = new FumeMappingProvider({
        fhirClient: mockClient
      });
    });

    it('should initialize alias provider when fhirClient provided', async () => {
      const providersModule = require('../../src/providers');
      expect(providersModule.AliasProvider).toHaveBeenCalledWith(
        mockClient,
        undefined
      );
    });

    it('should load aliases during initialize', async () => {
      const mockAliases = { key1: 'value1', key2: 'value2' };
      mockAliasProvider.loadAliases.mockResolvedValue(mockAliases);

      await provider.initialize();

      expect(mockAliasProvider.loadAliases).toHaveBeenCalled();
      
      const aliases = provider.getAliases();
      expect(aliases).toEqual({
        ...builtInAliases,
        ...mockAliases
      });
    });

    it('should return built-in aliases when no aliases loaded', () => {
      const aliases = provider.getAliases();
      expect(aliases).toEqual(builtInAliases);
    });

    it('should reload aliases from server', async () => {
      const mockAliases = { key1: 'value1' };
      mockAliasProvider.loadAliases.mockResolvedValue(mockAliases);

      await provider.reloadAliases();

      expect(mockAliasProvider.loadAliases).toHaveBeenCalled();
      
      const aliases = provider.getAliases();
      expect(aliases).toEqual({
        ...builtInAliases,
        ...mockAliases
      });
    });

    it('should register a new alias optimistically', async () => {
      mockAliasProvider.loadAliases.mockResolvedValue({});
      await provider.initialize();

      provider.registerAlias('newKey', 'newValue');

      const aliases = provider.getAliases();
      expect(aliases.newKey).toBe('newValue');
    });

    it('should update an existing alias optimistically', async () => {
      const mockAliases = { key1: 'value1' };
      mockAliasProvider.loadAliases.mockResolvedValue(mockAliases);
      await provider.initialize();

      provider.registerAlias('key1', 'updatedValue');

      const aliases = provider.getAliases();
      expect(aliases.key1).toBe('updatedValue');
    });

    it('should allow user alias to override a built-in alias', async () => {
      mockAliasProvider.loadAliases.mockResolvedValue({});
      await provider.initialize();

      expect(provider.getAliases().ucum).toBe('http://unitsofmeasure.org');

      provider.registerAlias('ucum', 'http://example.com/custom-ucum');
      expect(provider.getAliases().ucum).toBe('http://example.com/custom-ucum');
    });

    it('should delete an alias from cache', async () => {
      const mockAliases = { key1: 'value1', key2: 'value2' };
      mockAliasProvider.loadAliases.mockResolvedValue(mockAliases);
      await provider.initialize();

      provider.deleteAlias('key1');

      const aliases = provider.getAliases();
      expect(aliases).not.toHaveProperty('key1');
      expect(aliases.key2).toBe('value2');
    });

    it('should return copy of aliases object', async () => {
      const mockAliases = { key1: 'value1' };
      mockAliasProvider.loadAliases.mockResolvedValue(mockAliases);
      await provider.initialize();

      const aliases1 = provider.getAliases();
      const aliases2 = provider.getAliases();

      // Should be equal but not same reference
      expect(aliases1).toEqual(aliases2);
      expect(aliases1).not.toBe(aliases2);

      // Modifying returned object shouldn't affect cache
      aliases1.key1 = 'modified';
      const aliases3 = provider.getAliases();
      expect(aliases3.key1).toBe('value1');
    });
  });

  describe('Converters', () => {
    it('should call structureMapToExpression', () => {
      const provider = new FumeMappingProvider({});
      const structureMap: StructureMap = {
        resourceType: 'StructureMap',
        id: 'test-map',
        group: [
          {
            name: 'fumeMapping',
            rule: [
              {
                extension: [
                  {
                    url: 'http://fhir.fume.health/StructureDefinition/mapping-expression',
                    valueExpression: {
                      language: 'application/vnd.outburn.fume',
                      expression: 'test expression'
                    }
                  }
                ]
              }
            ]
          }
        ]
      };
      const result = provider.structureMapToExpression(structureMap);
      expect(result).toBe('test expression');
    });

    it('should call expressionToStructureMap', () => {
      const provider = new FumeMappingProvider({ canonicalBaseUrl: 'https://example.com' });
      const result = provider.expressionToStructureMap('test-id', 'test-expression');
      expect(result.resourceType).toBe('StructureMap');
      expect(result.id).toBe('test-id');
      expect(result.url).toContain('test-id');
      expect(result.url).toContain('https://example.com');
    });

    it('should call conceptMapToAliasObject', () => {
      const provider = new FumeMappingProvider({});
      const conceptMap: ConceptMap = {
        resourceType: 'ConceptMap',
        status: 'active',
        name: 'FumeAliases',
        group: [
          {
            element: [
              {
                code: 'key1',
                target: [{ code: 'value1', equivalence: 'equivalent' }]
              },
              {
                code: 'key2',
                target: [{ code: 'value2', equivalence: 'equivalent' }]
              }
            ]
          }
        ]
      };
      const result = provider.conceptMapToAliasObject(conceptMap);
      expect(result).toEqual({ key1: 'value1', key2: 'value2' });
    });

    it('should call aliasObjectToConceptMap', () => {
      const provider = new FumeMappingProvider({ canonicalBaseUrl: 'https://example.com' });
      const aliases = { key1: 'value1', key2: 'value2' };
      const result = provider.aliasObjectToConceptMap(aliases);
      expect(result.resourceType).toBe('ConceptMap');
      expect(result.name).toBe('FumeAliases');
      expect(result.group?.[0]?.element).toHaveLength(2);
    });
  });
});
