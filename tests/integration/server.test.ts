import { FhirClient } from '@outburn/fhir-client';
import { FumeMappingProvider } from '../../src';

const HAPI_BASE_URL = 'http://localhost:8081/fhir';

// Helper function to create a valid FUME StructureMap
function createFumeStructureMap(id: string, expression: string, url?: string) {
  return {
    resourceType: 'StructureMap',
    id,
    url: url || `http://test.example.com/StructureMap/${id}`,
    name: id.replace(/-/g, '_'),
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
                  expression
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
}

describe('Server Integration Tests', () => {
  let client: FhirClient;
  let provider: FumeMappingProvider;
  const createdResourceIds: string[] = [];

  beforeAll(async () => {
    // Verify server is accessible
    const testClient = new FhirClient({
      baseUrl: HAPI_BASE_URL,
      fhirVersion: 'R4'
    });
    const capabilities = await testClient.getCapabilities();
    expect(capabilities.fhirVersion).toBe('4.0.1');

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

  describe('Basic server mapping operations', () => {
    beforeEach(async () => {
      // Create a fresh client for each test to avoid caching issues
      client = new FhirClient({
        baseUrl: HAPI_BASE_URL,
        fhirVersion: 'R4'
      });
      
      provider = new FumeMappingProvider({
        fhirClient: client
      });
    });

    it('should initialize with no mappings on empty server', async () => {
      await provider.initialize();
      const mappings = provider.getUserMappings();
      expect(mappings).toEqual([]);
    });

    it('should load server mappings', async () => {
      // Create a test StructureMap on the server
      const structureMap = createFumeStructureMap(
        'test-server-map-1',
        '$output = { test: "server" }',
        'http://test.example.com/StructureMap/test-1'
      );

      const created = await client.update(structureMap);
      createdResourceIds.push(created.id);

      // Initialize provider and load mappings
      await provider.initialize();
      
      const mappings = provider.getUserMappings();
      expect(mappings.length).toBe(1);
      expect(mappings[0].key).toBe('test-server-map-1');
      expect(mappings[0].source).toBe('server');
      expect(mappings[0].expression).toBe('$output = { test: "server" }');
      expect(mappings[0].url).toBe('http://test.example.com/StructureMap/test-1');
    });

    it('should refresh server mapping', async () => {
      // Create initial mapping
      let structureMap = createFumeStructureMap(
        'test-refresh-map',
        '$output = { version: 1 }',
        'http://test.example.com/StructureMap/refresh'
      );

      await client.update(structureMap);
      createdResourceIds.push('test-refresh-map');

      await provider.initialize();
      
      let mapping = provider.getUserMapping('test-refresh-map');
      expect(mapping?.expression).toBe('$output = { version: 1 }');

      // Update the mapping on the server
      structureMap = createFumeStructureMap(
        'test-refresh-map',
        '$output = { version: 2 }',
        'http://test.example.com/StructureMap/refresh'
      );
      await client.update(structureMap);

      // Refresh
      const refreshed = await provider.refreshUserMapping('test-refresh-map');
      expect(refreshed?.expression).toBe('$output = { version: 2 }');
      
      mapping = provider.getUserMapping('test-refresh-map');
      expect(mapping?.expression).toBe('$output = { version: 2 }');
    });
  });

  describe('Large dataset pagination test', () => {
    it('should fetch all mappings when there are 200+ StructureMaps', async () => {
      // Create 250 test StructureMaps
      const createPromises = [];
      for (let i = 0; i < 250; i++) {
        const structureMap = createFumeStructureMap(
          `pagination-test-${i}`,
          `$output = { index: ${i} }`,
          `http://test.example.com/StructureMap/pagination-${i}`
        );

        createPromises.push(
          client.update(structureMap).then(created => {
            createdResourceIds.push(created.id);
          })
        );

        // Batch in groups of 50 to avoid overwhelming the server
        if (i % 50 === 49) {
          await Promise.all(createPromises.splice(0, createPromises.length));
        }
      }

      // Wait for any remaining creates
      await Promise.all(createPromises);

      // Initialize provider
      provider = new FumeMappingProvider({
        fhirClient: client
      });

      await provider.initialize();

      // Verify all mappings were loaded
      const mappings = provider.getUserMappings();
      expect(mappings.length).toBeGreaterThanOrEqual(250);
      
      // Verify some specific mappings exist
      expect(provider.getUserMapping('pagination-test-0')).toBeDefined();
      expect(provider.getUserMapping('pagination-test-100')).toBeDefined();
      expect(provider.getUserMapping('pagination-test-249')).toBeDefined();
    }, 300000); // 5 minute timeout for this test
  });
});
