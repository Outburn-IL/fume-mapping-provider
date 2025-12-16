import { FhirClient } from '@outburn/fhir-client';
import { FumeMappingProvider } from '../../src/FumeMappingProvider';
import { ConceptMap } from '../../src/types';

const HAPI_BASE_URL = 'http://localhost:8081/fhir';

describe('Aliases Integration Tests', () => {
  let fhirClient: FhirClient;
  let provider: FumeMappingProvider;
  const baseUrl = HAPI_BASE_URL;

  beforeAll(() => {
    fhirClient = new FhirClient({ baseUrl, fhirVersion: 'R4' });
  });

  beforeEach(async () => {
    // Clean up any existing alias ConceptMap - delete all test alias resources
    const testIds = ['fume-test-aliases', 'fume-test-aliases-1', 'fume-test-aliases-2'];
    for (const id of testIds) {
      try {
        await fhirClient.delete('ConceptMap', id);
      } catch (_error) {
        // Resource might not exist
      }
    }

    provider = new FumeMappingProvider({
      fhirClient,
      logger: console
    });
  });

  afterEach(async () => {
    // Clean up - delete all test alias resources
    const testIds = ['fume-test-aliases', 'fume-test-aliases-1', 'fume-test-aliases-2'];
    for (const id of testIds) {
      try {
        await fhirClient.delete('ConceptMap', id);
      } catch (_error) {
        // Resource might not exist
      }
    }
  });

  it('should return empty object when no aliases exist', async () => {
    await provider.initialize();
    
    const aliases = provider.getAliases();
    expect(aliases).toEqual({});
  });

  it('should load aliases from server during initialization', async () => {
    // Create alias ConceptMap on server
    const conceptMap: ConceptMap = {
      resourceType: 'ConceptMap',
      id: 'fume-test-aliases',
      url: 'http://example.com/ConceptMap/fume-test-aliases',
      name: 'FumeAliases',
      status: 'active',
      publisher: 'Outburn Ltd.',
      description: 'The value associated with each FUME alias',
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
                display: 'FUME Mapping Engine'
              }
            ],
            text: 'FUME - FHIR-Utilized Mapping Engine'
          }
        }
      ],
      group: [
        {
          source: 'http://example.com/CodeSystem/fume-global-alias-name',
          target: 'http://example.com/CodeSystem/fume-global-alias-value',
          element: [
            {
              code: 'apiUrl',
              target: [{ code: 'http://api.example.com', equivalence: 'equivalent' }]
            },
            {
              code: 'defaultLang',
              target: [{ code: 'en-US', equivalence: 'equivalent' }]
            }
          ]
        }
      ]
    };

    await fhirClient.update(conceptMap);

    // Initialize provider and check aliases loaded
    await provider.initialize();
    
    const aliases = provider.getAliases();
    expect(aliases).toEqual({
      apiUrl: 'http://api.example.com',
      defaultLang: 'en-US'
    });
  });

  it('should reload aliases from server', async () => {
    await provider.initialize();
    expect(provider.getAliases()).toEqual({});

    // Create alias ConceptMap on server after initialization
    const conceptMap = FumeMappingProvider.aliasObjectToConceptMap(
      { newKey: 'newValue' },
      'http://example.com'
    );
    conceptMap.id = 'fume-test-aliases';
    try { await fhirClient.delete('ConceptMap', 'fume-test-aliases'); } catch {}
    await fhirClient.update(conceptMap);

    // Reload and check
    await provider.reloadAliases();
    
    const aliases = provider.getAliases();
    expect(aliases).toEqual({
      newKey: 'newValue'
    });
  });

  it('should handle optimistic alias updates', async () => {
    await provider.initialize();

    provider.registerAlias('key1', 'value1');
    provider.registerAlias('key2', 'value2');

    const aliases = provider.getAliases();
    expect(aliases).toEqual({
      key1: 'value1',
      key2: 'value2'
    });
  });

  it('should handle alias deletion', async () => {
    // Create aliases on server
    const conceptMap = FumeMappingProvider.aliasObjectToConceptMap(
      { key1: 'value1', key2: 'value2', key3: 'value3' },
      'http://example.com'
    );
    conceptMap.id = 'fume-test-aliases';
    try { await fhirClient.delete('ConceptMap', 'fume-test-aliases'); } catch {}
    await fhirClient.update(conceptMap);

    await provider.initialize();
    
    provider.deleteAlias('key2');

    const aliases = provider.getAliases();
    expect(aliases).toEqual({
      key1: 'value1',
      key3: 'value3'
    });
  });

  it('should skip loading when multiple alias resources found', async () => {
    // Create two alias ConceptMaps (invalid state) with different URLs
    const conceptMap1 = FumeMappingProvider.aliasObjectToConceptMap(
      { key1: 'value1' },
      'http://example.com/v1'
    );
    conceptMap1.id = 'fume-test-aliases-1';
    const conceptMap2 = FumeMappingProvider.aliasObjectToConceptMap(
      { key2: 'value2' },
      'http://example.com/v2'
    );
    conceptMap2.id = 'fume-test-aliases-2';

    try { await fhirClient.delete('ConceptMap', 'fume-test-aliases-1'); } catch {}
    try { await fhirClient.delete('ConceptMap', 'fume-test-aliases-2'); } catch {}
    await fhirClient.update(conceptMap1);
    await fhirClient.update(conceptMap2);

    await provider.initialize();
    
    // Should return empty object due to multiple resources
    const aliases = provider.getAliases();
    expect(aliases).toEqual({});
  });

  it('should skip ConceptMaps without correct useContext', async () => {
    // Create ConceptMap without FUME useContext
    const conceptMap: ConceptMap = {
      resourceType: 'ConceptMap',
      id: 'fume-test-aliases',
      url: 'http://example.com/ConceptMap/fume-test-aliases-no-context',
      name: 'FumeAliases',
      status: 'active',
      group: [
        {
          source: 'http://example.com/source',
          target: 'http://example.com/target',
          element: [
            { code: 'key1', target: [{ code: 'value1' }] }
          ]
        }
      ]
    };

    await fhirClient.update(conceptMap);

    await provider.initialize();
    
    // Should return empty object due to missing useContext
    const aliases = provider.getAliases();
    expect(aliases).toEqual({});
  });

  it('should round-trip aliases through server', async () => {
    const originalAliases = {
      systemUrl: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      version: '2.1.0',
      display: 'Test System'
    };

    // Convert to ConceptMap and upload
    const conceptMap = FumeMappingProvider.aliasObjectToConceptMap(
      originalAliases,
      'http://example.com'
    );
    conceptMap.id = 'fume-test-aliases';
    try { await fhirClient.delete('ConceptMap', 'fume-test-aliases'); } catch {}
    await fhirClient.update(conceptMap);

    // Load through provider
    await provider.initialize();
    const loadedAliases = provider.getAliases();

    expect(loadedAliases).toEqual(originalAliases);
  });
});
