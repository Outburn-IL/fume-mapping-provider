import { FhirPackageExplorer } from 'fhir-package-explorer';
import { FhirClient } from '@outburn/fhir-client';
import { FumeMappingProvider } from '../../src/FumeMappingProvider';
import { UserMappingProvider, PackageMappingProvider } from '../../src/providers';
import { StructureMap, ConceptMap } from '../../src/types';
import { builtInAliases } from '../../src/builtInAliases';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

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

      (UserMappingProvider as unknown as jest.Mock).mockImplementation(() => mockUserProvider);

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
      loadAliasesWithMetadata?: jest.Mock;
    };

    beforeEach(() => {
      mockClient = new FhirClient({ baseUrl: 'http://test.com', fhirVersion: 'R4' });
      
      mockAliasProvider = {
        loadAliases: jest.fn(),
        loadAliasesWithMetadata: jest.fn()
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
      mockAliasProvider.loadAliasesWithMetadata?.mockResolvedValue({ aliases: mockAliases, resourceId: 'alias-cm-1' });

      await provider.initialize();

      expect(mockAliasProvider.loadAliasesWithMetadata).toHaveBeenCalled();
      expect(provider.getAliasResourceId()).toBe('alias-cm-1');
      
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
      mockAliasProvider.loadAliasesWithMetadata?.mockResolvedValue({ aliases: mockAliases, resourceId: 'alias-cm-2' });

      await provider.reloadAliases();

      expect(mockAliasProvider.loadAliasesWithMetadata).toHaveBeenCalled();
      expect(provider.getAliasResourceId()).toBe('alias-cm-2');
      
      const aliases = provider.getAliases();
      expect(aliases).toEqual({
        ...builtInAliases,
        ...mockAliases
      });
    });

    it('should register a new alias optimistically', async () => {
      mockAliasProvider.loadAliasesWithMetadata?.mockResolvedValue({ aliases: {}, resourceId: undefined });
      await provider.initialize();

      provider.registerAlias('newKey', 'newValue');

      const aliases = provider.getAliases();
      expect(aliases.newKey).toBe('newValue');
    });

    it('should update an existing alias optimistically', async () => {
      const mockAliases = { key1: 'value1' };
      mockAliasProvider.loadAliasesWithMetadata?.mockResolvedValue({ aliases: mockAliases, resourceId: 'alias-cm-3' });
      await provider.initialize();

      provider.registerAlias('key1', 'updatedValue');

      const aliases = provider.getAliases();
      expect(aliases.key1).toBe('updatedValue');
    });

    it('should allow user alias to override a built-in alias', async () => {
      mockAliasProvider.loadAliasesWithMetadata?.mockResolvedValue({ aliases: {}, resourceId: undefined });
      await provider.initialize();

      expect(provider.getAliases().ucum).toBe('http://unitsofmeasure.org');

      provider.registerAlias('ucum', 'http://example.com/custom-ucum');
      expect(provider.getAliases().ucum).toBe('http://example.com/custom-ucum');
    });

    it('should delete an alias from cache', async () => {
      const mockAliases = { key1: 'value1', key2: 'value2' };
      mockAliasProvider.loadAliasesWithMetadata?.mockResolvedValue({ aliases: mockAliases, resourceId: 'alias-cm-4' });
      await provider.initialize();

      provider.deleteAlias('key1');

      const aliases = provider.getAliases();
      expect(aliases).not.toHaveProperty('key1');
      expect(aliases.key2).toBe('value2');
    });

    it('should return copy of aliases object', async () => {
      const mockAliases = { key1: 'value1' };
      mockAliasProvider.loadAliasesWithMetadata?.mockResolvedValue({ aliases: mockAliases, resourceId: 'alias-cm-5' });
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

    it('should expose alias metadata via getAliasesWithMetadata', async () => {
      const mockAliases = { key1: 'value1' };
      mockAliasProvider.loadAliasesWithMetadata?.mockResolvedValue({ aliases: mockAliases, resourceId: 'alias-cm-5' });
      await provider.initialize();

      const withMeta = provider.getAliasesWithMetadata();
      expect(withMeta.key1).toEqual({
        value: 'value1',
        sourceType: 'server',
        source: 'http://test.com/ConceptMap/alias-cm-5'
      });

      // built-ins are included with builtIn metadata
      expect(withMeta.ucum.sourceType).toBe('builtIn');
      expect(withMeta.ucum.value).toBe(builtInAliases.ucum);
    });
  });

  describe('File Aliases (aliases.json)', () => {
    const createTempFolder = async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fume-mappings-'));
      return dir;
    };

    const writeAliasesJson = async (folder: string, content: unknown) => {
      const filePath = path.join(folder, 'aliases.json');
      await fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf-8');
      return filePath;
    };

    beforeEach(() => {
      // Ensure user provider is harmless for these tests
      (UserMappingProvider as unknown as jest.Mock).mockImplementation(() => ({
        loadMappings: jest.fn().mockResolvedValue(new Map()),
        refreshMapping: jest.fn()
      }));
    });

    it('should not load file aliases when no mappingsFolder configured', async () => {
      const provider = new FumeMappingProvider({});
      await provider.initialize();
      expect(provider.getAliases()).toEqual(builtInAliases);
    });

    it('should not load file aliases when aliases.json is missing', async () => {
      const folder = await createTempFolder();
      const provider = new FumeMappingProvider({ mappingsFolder: folder });
      await provider.initialize();

      expect(provider.getAliases()).toEqual(builtInAliases);
    });

    it('should load valid aliases.json and expose metadata source as absolute path', async () => {
      const folder = await createTempFolder();
      await writeAliasesJson(folder, { myAlias: 'myValue', other_alias: 'x', _private: 'y', '1b': 'z', '1_c': 'w' });

      const provider = new FumeMappingProvider({ mappingsFolder: folder });
      await provider.initialize();

      const aliases = provider.getAliases();
      expect(aliases.myAlias).toBe('myValue');
      expect(aliases._private).toBe('y');
      expect(aliases['1b']).toBe('z');
      expect(aliases['1_c']).toBe('w');

      const meta = provider.getAliasesWithMetadata();
      expect(meta.myAlias.sourceType).toBe('file');
      expect(meta.myAlias.source).toBe(path.resolve(folder, 'aliases.json'));
    });

    it('should warn+ignore invalid entries in aliases.json (not fatal)', async () => {
      const folder = await createTempFolder();
      await writeAliasesJson(folder, { 'bad-key': 'x', okKey: 123, goodKey: 'ok' });

      const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const provider = new FumeMappingProvider({ mappingsFolder: folder, logger: mockLogger });
      await expect(provider.initialize()).resolves.toBeUndefined();

      const aliases = provider.getAliases();
      expect(aliases.goodKey).toBe('ok');
      expect(aliases).not.toHaveProperty('bad-key');
      expect(aliases).not.toHaveProperty('okKey');
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should warn+ignore malformed JSON in aliases.json (not fatal)', async () => {
      const folder = await createTempFolder();
      const filePath = path.join(folder, 'aliases.json');
      await fs.writeFile(filePath, '{ this is not json', 'utf-8');

      const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const provider = new FumeMappingProvider({ mappingsFolder: folder, logger: mockLogger });
      await expect(provider.initialize()).resolves.toBeUndefined();
      expect(provider.getAliases()).toEqual(builtInAliases);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should merge server + file + built-in with file overriding server, and delete fallback file->server->builtIn', async () => {
      const folder = await createTempFolder();
      await writeAliasesJson(folder, { loinc: 'file-loinc', onlyFile: 'file-only' });

      const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const mockClient = new FhirClient({ baseUrl: 'http://test.com', fhirVersion: 'R4' });

      const mockAliasProvider = {
        loadAliasesWithMetadata: jest.fn().mockResolvedValue({
          aliases: { loinc: 'server-loinc', onlyServer: 'server-only' },
          resourceId: 'alias-cm-1'
        })
      };

      // Mock AliasProvider
      const providersModule = require('../../src/providers');
      providersModule.AliasProvider = jest.fn().mockImplementation(() => mockAliasProvider);

      const provider = new FumeMappingProvider({
        mappingsFolder: folder,
        fhirClient: mockClient,
        logger: mockLogger
      });

      await provider.initialize();

      // Collision resolution: file wins over server
      expect(provider.getAliases().loinc).toBe('file-loinc');
      expect(provider.getAliasesWithMetadata().loinc.sourceType).toBe('file');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("File alias 'loinc' overrides server alias")
      );

      // Delete file alias -> should reveal server alias
      provider.deleteAlias('loinc');
      expect(provider.getAliases().loinc).toBe('server-loinc');
      expect(provider.getAliasesWithMetadata().loinc).toEqual({
        value: 'server-loinc',
        sourceType: 'server',
        source: 'http://test.com/ConceptMap/alias-cm-1'
      });

      // Delete server alias -> should reveal built-in alias
      provider.deleteAlias('loinc');
      expect(provider.getAliases().loinc).toBe(builtInAliases.loinc);
      expect(provider.getAliasesWithMetadata().loinc.sourceType).toBe('builtIn');
    });

    it('should forbid .json as mapping fileExtension', () => {
      expect(() => new FumeMappingProvider({ mappingsFolder: '/x', fileExtension: '.json' })).toThrow(
        /fileExtension.*\.json.*reserved/i
      );
      expect(() => new FumeMappingProvider({ mappingsFolder: '/x', fileExtension: 'json' })).toThrow(
        /fileExtension.*\.json.*reserved/i
      );
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
