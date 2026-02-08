import { FhirPackageExplorer } from 'fhir-package-explorer';
import { FumeMappingProvider } from '../../src';
import * as path from 'path';

const CACHE_PATH = path.join(__dirname, '..', 'fixtures');

describe('Package Integration Tests', () => {
  let explorer: FhirPackageExplorer;
  let provider: FumeMappingProvider;

  beforeAll(async () => {
    // Create FPE instance with our test package in the cache
    explorer = await FhirPackageExplorer.create({
      context: ['fume.test.pkg@0.1.0'],
      cachePath: CACHE_PATH,
      fhirVersion: 'R4'
    });
  });

  it('should load package mappings from FPE', async () => {
    provider = new FumeMappingProvider({
      packageExplorer: explorer,
      filePollingIntervalMs: 0,
      serverPollingIntervalMs: 0,
      forcedResyncIntervalMs: 0
    });

    const mappings = await provider.getPackageMappings();
    
    expect(mappings.length).toBe(2);
    
    const patientMapping = mappings.find(m => m.id === 'patient-to-bundle');
    expect(patientMapping).toBeDefined();
    expect(patientMapping!.packageId).toBe('fume.test.pkg');
    expect(patientMapping!.packageVersion).toBe('0.1.0');
    expect(patientMapping!.url).toBe('http://test.fume.health/StructureMap/patient-to-bundle');
    expect(patientMapping!.expression).toContain('resourceType: \'Bundle\'');
    
    const obsMapping = mappings.find(m => m.id === 'observation-transform');
    expect(obsMapping).toBeDefined();
    expect(obsMapping!.packageId).toBe('fume.test.pkg');
    expect(obsMapping!.name).toBe('ObservationTransform');
  });

  it('should get package mapping metadata', async () => {
    provider = new FumeMappingProvider({
      packageExplorer: explorer,
      filePollingIntervalMs: 0,
      serverPollingIntervalMs: 0,
      forcedResyncIntervalMs: 0
    });

    const metadata = await provider.getPackageMappingsMetadata();
    
    expect(metadata.length).toBe(2);
    expect(metadata[0]).not.toHaveProperty('expression');
    expect(metadata[0]).toHaveProperty('id');
    expect(metadata[0]).toHaveProperty('packageId');
    expect(metadata[0]).toHaveProperty('packageVersion');
    expect(metadata[0]).toHaveProperty('filename');
  });

  it('should get package mapping by URL identifier', async () => {
    provider = new FumeMappingProvider({
      packageExplorer: explorer,
      filePollingIntervalMs: 0,
      serverPollingIntervalMs: 0,
      forcedResyncIntervalMs: 0
    });

    const mapping = await provider.getPackageMapping('http://test.fume.health/StructureMap/patient-to-bundle');
    
    expect(mapping).toBeDefined();
    expect(mapping!.id).toBe('patient-to-bundle');
    expect(mapping!.expression).toContain('resourceType: \'Bundle\'');
  });

  it('should get package mapping by ID identifier', async () => {
    provider = new FumeMappingProvider({
      packageExplorer: explorer,
      filePollingIntervalMs: 0,
      serverPollingIntervalMs: 0,
      forcedResyncIntervalMs: 0
    });

    const mapping = await provider.getPackageMapping('observation-transform');
    
    expect(mapping).toBeDefined();
    expect(mapping!.id).toBe('observation-transform');
    expect(mapping!.url).toBe('http://test.fume.health/StructureMap/observation-transform');
  });

  it('should get package mapping by name identifier', async () => {
    provider = new FumeMappingProvider({
      packageExplorer: explorer,
      filePollingIntervalMs: 0,
      serverPollingIntervalMs: 0,
      forcedResyncIntervalMs: 0
    });

    const mapping = await provider.getPackageMapping('PatientToBundle');
    
    expect(mapping).toBeDefined();
    expect(mapping!.id).toBe('patient-to-bundle');
    expect(mapping!.name).toBe('PatientToBundle');
  });

  it('should return null for non-existent identifier', async () => {
    provider = new FumeMappingProvider({
      packageExplorer: explorer,
      filePollingIntervalMs: 0,
      serverPollingIntervalMs: 0,
      forcedResyncIntervalMs: 0
    });

    const mapping = await provider.getPackageMapping('non-existent-mapping');
    
    expect(mapping).toBeNull();
  });

  it('should filter by package context', async () => {
    provider = new FumeMappingProvider({
      packageExplorer: explorer,
      filePollingIntervalMs: 0,
      serverPollingIntervalMs: 0,
      forcedResyncIntervalMs: 0
    });

    // Get all mappings from our test package
    const mappings = await provider.getPackageMappings({
      packageContext: 'fume.test.pkg@0.1.0'
    });
    
    expect(mappings.length).toBe(2);
    expect(mappings.every(m => m.packageId === 'fume.test.pkg')).toBe(true);
  });

  it('should handle package context filtering in getPackageMapping', async () => {
    provider = new FumeMappingProvider({
      packageExplorer: explorer,
      filePollingIntervalMs: 0,
      serverPollingIntervalMs: 0,
      forcedResyncIntervalMs: 0
    });

    // This should find the mapping
    const mapping1 = await provider.getPackageMapping('patient-to-bundle', {
      packageContext: 'fume.test.pkg@0.1.0'
    });
    expect(mapping1).toBeDefined();

    // This should not find anything (different package context)
    const mapping2 = await provider.getPackageMapping('patient-to-bundle', {
      packageContext: 'some.other.package@1.0.0'
    });
    expect(mapping2).toBeNull();
  });

  it('should work without initialize for package mappings', async () => {
    // Package mappings don't require initialize() since FPE is already initialized
    provider = new FumeMappingProvider({
      packageExplorer: explorer,
      filePollingIntervalMs: 0,
      serverPollingIntervalMs: 0,
      forcedResyncIntervalMs: 0
    });

    // Should work immediately without calling initialize()
    const mappings = await provider.getPackageMappings();
    expect(mappings.length).toBe(2);
  });

  it('should handle mixed user and package mappings', async () => {
    const mappingsFolder = path.join(__dirname, '..', 'fixtures', 'mappings');
    
    provider = new FumeMappingProvider({
      packageExplorer: explorer,
      mappingsFolder: mappingsFolder,
      filePollingIntervalMs: 0,
      serverPollingIntervalMs: 0,
      forcedResyncIntervalMs: 0
    });

    await provider.initialize();

    // User mappings should be cached
    const userMappings = provider.getUserMappings();
    expect(userMappings.length).toBe(3);

    // Package mappings should be fetchable
    const packageMappings = await provider.getPackageMappings();
    expect(packageMappings.length).toBe(2);

    // They should have different data structures
    expect(userMappings[0]).toHaveProperty('key');
    expect(userMappings[0]).toHaveProperty('source');
    expect(packageMappings[0]).toHaveProperty('packageId');
    expect(packageMappings[0]).toHaveProperty('packageVersion');
  });
});
