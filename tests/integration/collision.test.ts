import { FhirClient } from '@outburn/fhir-client';
import { FumeMappingProvider } from '../../src';
import * as path from 'path';

const HAPI_BASE_URL = 'http://localhost:8081/fhir';
const MAPPINGS_FOLDER = path.join(__dirname, '..', 'fixtures', 'mappings');

describe('File/Server Collision Tests', () => {
  let client: FhirClient;
  let provider: FumeMappingProvider;
  const createdResourceIds: string[] = [];

  beforeAll(async () => {
    // Verify server is accessible with a test client
    const testClient = new FhirClient({
      baseUrl: HAPI_BASE_URL,
      fhirVersion: 'R4'
    });

    // Clean up any leftover StructureMaps from previous test runs
    try {
      const existingMaps = await testClient.search('StructureMap', {}, { fetchAll: true, noCache: true });
      if (existingMaps && Array.isArray(existingMaps)) {
        for (const map of existingMaps) {
          if (map.id) {
            try {
              await testClient.delete('StructureMap', map.id);
            } catch {
              // Ignore deletion errors
            }
          }
        }
      }
    } catch {
      // Ignore search errors
    }
  });

  afterAll(async () => {
    // Cleanup: delete all created resources
    const cleanupClient = new FhirClient({
      baseUrl: HAPI_BASE_URL,
      fhirVersion: 'R4'
    });
    for (const id of createdResourceIds) {
      try {
        await cleanupClient.delete('StructureMap', id);
      } catch {
        // Ignore errors during cleanup
      }
    }
  });

  it('should load file mappings without server', async () => {
    // Create a fresh client for this test
    client = new FhirClient({
      baseUrl: HAPI_BASE_URL,
      fhirVersion: 'R4'
    });
    
    provider = new FumeMappingProvider({
      mappingsFolder: MAPPINGS_FOLDER
    });

    await provider.initialize();

    const mappings = provider.getUserMappings();
    expect(mappings.length).toBe(3);
    expect(mappings.every(m => m.source === 'file')).toBe(true);
    
    const keys = provider.getUserMappingKeys();
    expect(keys).toContain('fileMapping1');
    expect(keys).toContain('fileMapping2');
    expect(keys).toContain('serverMappingCollision');
  });

  it('should override server mapping with file mapping on key collision', async () => {
    // Create a fresh client for this test
    client = new FhirClient({
      baseUrl: HAPI_BASE_URL,
      fhirVersion: 'R4'
    });
    
    // Create a server mapping with same ID as file mapping
    const structureMap = {
      resourceType: 'StructureMap',
      id: 'serverMappingCollision',
      url: 'http://test.example.com/StructureMap/collision',
      name: 'ServerMappingCollision',
      status: 'active',
      useContext: [
        {
          code: {
            system: 'http://snomed.info/sct',
            code: '706594005',
            display: 'Information system software'
          },
          valueCodeableConcept: {
            coding: [
              {
                system: 'http://codes.fume.health',
                code: 'fume',
                display: 'FUME'
              }
            ],
            text: 'FUME'
          }
        }
      ],
      group: [
        {
          name: 'fumeMapping',
          typeMode: 'none',
          input: [{ name: 'input', mode: 'source' }],
          rule: [
            {
              extension: [
                {
                  url: 'http://fhir.fume.health/StructureDefinition/mapping-expression',
                  valueExpression: {
                    language: 'application/vnd.outburn.fume',
                    expression: '// original server mapping'
                  }
                }
              ],
              name: 'evaluate',
              source: [{ context: 'input' }]
            }
          ]
        }
      ]
    };

    await client.update(structureMap);
  createdResourceIds.push('serverMappingCollision');

    // Create provider with both file and server
    const mockLogger = {
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn()
    };

    provider = new FumeMappingProvider({
      mappingsFolder: MAPPINGS_FOLDER,
      fhirClient: client,
      logger: mockLogger
    });

    await provider.initialize();

    // Verify collision warning was logged
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("File mapping 'serverMappingCollision' overrides server mapping")
    );

    // Verify file mapping takes precedence
    const mapping = provider.getUserMapping('serverMappingCollision');
    expect(mapping).toBeDefined();
    expect(mapping!.source).toBe('file');
    expect(mapping!.expression).toContain('* type = \'batch\'');
    expect(mapping!.expression).not.toContain('source: "server"');
  });

  it('should handle refresh correctly with collision', async () => {
    // Create a fresh client for this test
    client = new FhirClient({
      baseUrl: HAPI_BASE_URL,
      fhirVersion: 'R4'
    });
    
    // Setup: server + file with collision
    const structureMap = {
      resourceType: 'StructureMap',
      id: 'refreshCollisionTest',
      url: 'http://test.example.com/StructureMap/refresh-collision',
      name: 'RefreshCollisionTest',
      status: 'active',
      useContext: [
        {
          code: {
            system: 'http://snomed.info/sct',
            code: '706594005',
            display: 'Information system software'
          },
          valueCodeableConcept: {
            coding: [
              {
                system: 'http://codes.fume.health',
                code: 'fume',
                display: 'FUME'
              }
            ],
            text: 'FUME'
          }
        }
      ],
      group: [
        {
          name: 'fumeMapping',
          typeMode: 'none',
          input: [{ name: 'input', mode: 'source' }],
          rule: [
            {
              extension: [
                {
                  url: 'http://fhir.fume.health/StructureDefinition/mapping-expression',
                  valueExpression: {
                    language: 'application/vnd.outburn.fume',
                    expression: '$output := { "source": "server" }'
                  }
                }
              ],
              name: 'evaluate',
              source: [{ context: 'input' }]
            }
          ]
        }
      ]
    };

    await client.update(structureMap);
  createdResourceIds.push('refreshCollisionTest');

    // Create file mapping with same key
    const fs = await import('fs/promises');
    const testFilePath = path.join(MAPPINGS_FOLDER, 'refreshCollisionTest.fume');
    await fs.writeFile(testFilePath, '$output := { "source": "file" }');

    try {
      provider = new FumeMappingProvider({
        mappingsFolder: MAPPINGS_FOLDER,
        fhirClient: client
      });

      await provider.initialize();

      // Should have file version
      let mapping = provider.getUserMapping('refreshCollisionTest');
      expect(mapping?.source).toBe('file');
      expect(mapping?.expression).toContain('"source": "file"');

      // Update file
      await fs.writeFile(testFilePath, '$output := { "source": "file", "updated": true }');

      // Refresh - should still get file version
      await provider.refreshUserMapping('refreshCollisionTest');
      mapping = provider.getUserMapping('refreshCollisionTest');
      expect(mapping?.source).toBe('file');
      expect(mapping?.expression).toContain('"updated": true');

      // Delete file
      await fs.unlink(testFilePath);

      // Refresh - should now fall back to server version
      await provider.refreshUserMapping('refreshCollisionTest');
      mapping = provider.getUserMapping('refreshCollisionTest');
      expect(mapping?.source).toBe('server');
      expect(mapping?.expression).toContain('"source": "server"');
    } finally {
      // Cleanup test file if it exists
      try {
        await fs.unlink(testFilePath);
      } catch {
        // Ignore if already deleted
      }
    }
  });

  it('should provide correct metadata for mixed sources', async () => {
    // Create a fresh client for this test
    client = new FhirClient({
      baseUrl: HAPI_BASE_URL,
      fhirVersion: 'R4'
    });
    
    // Create server mappings
    const serverMap1 = {
      resourceType: 'StructureMap',
      id: 'mixedServer1',
      url: 'http://test.example.com/StructureMap/mixedServer1',
      name: 'MixedServer1',
      status: 'active',
      useContext: [
        {
          code: {
            system: 'http://snomed.info/sct',
            code: '706594005',
            display: 'Information system software'
          },
          valueCodeableConcept: {
            coding: [
              {
                system: 'http://codes.fume.health',
                code: 'fume',
                display: 'FUME'
              }
            ],
            text: 'FUME'
          }
        }
      ],
      group: [
        {
          name: 'fumeMapping',
          typeMode: 'none',
          input: [{ name: 'input', mode: 'source' }],
          rule: [
            {
              extension: [
                {
                  url: 'http://fhir.fume.health/StructureDefinition/mapping-expression',
                  valueExpression: {
                    language: 'application/vnd.outburn.fume',
                    expression: '$output := { }'
                  }
                }
              ],
              name: 'evaluate',
              source: [{ context: 'input' }]
            }
          ]
        }
      ]
    };

    await client.update(serverMap1);
  createdResourceIds.push('mixedServer1');

    provider = new FumeMappingProvider({
      mappingsFolder: MAPPINGS_FOLDER,
      fhirClient: client
    });

    await provider.initialize();

    const metadata = provider.getUserMappingsMetadata();
    
    // Should have both file and server mappings
    const fileMappings = metadata.filter(m => m.source === 'file');
    const serverMappings = metadata.filter(m => m.source === 'server');
    
    expect(fileMappings.length).toBeGreaterThan(0);
    expect(serverMappings.length).toBeGreaterThan(0);

    // Verify file mapping metadata
    const fileMapping = fileMappings.find(m => m.key === 'fileMapping1');
    expect(fileMapping).toBeDefined();
    expect(fileMapping!.filename).toBe('fileMapping1.fume');
    expect(fileMapping!.sourceServer).toBeUndefined();

    // Verify server mapping metadata
    const serverMapping = serverMappings.find(m => m.key === 'mixedServer1');
    expect(serverMapping).toBeDefined();
    expect(serverMapping!.url).toBe('http://test.example.com/StructureMap/mixedServer1');
    expect(serverMapping!.sourceServer).toBe(HAPI_BASE_URL);
    expect(serverMapping!.filename).toBeUndefined();
  });
});
