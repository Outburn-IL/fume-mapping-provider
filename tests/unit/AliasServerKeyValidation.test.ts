import { FhirClient } from '@outburn/fhir-client';
import { FumeMappingProvider } from '../../src/FumeMappingProvider';
import { UserMappingProvider, PackageMappingProvider } from '../../src/providers';
import { builtInAliases } from '../../src/builtInAliases';

jest.mock('../../src/providers');

describe('Server alias key validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should warn+ignore invalid server alias keys', async () => {
    const mockClient = new FhirClient({ baseUrl: 'http://test.com', fhirVersion: 'R4' });

    // keep other providers inert
    (UserMappingProvider as unknown as jest.Mock).mockImplementation(() => ({
      loadMappings: jest.fn().mockResolvedValue(new Map()),
      refreshMapping: jest.fn()
    }));
    (PackageMappingProvider as unknown as jest.Mock).mockImplementation(() => ({
      loadMappings: jest.fn(),
      getMapping: jest.fn()
    }));

    const mockAliasProvider = {
      loadAliasesWithMetadata: jest.fn().mockResolvedValue({
        aliases: {
          goodKey: 'ok',
          'bad-key': 'nope'
        },
        resourceId: 'alias-cm-1'
      })
    };

    const providersModule = require('../../src/providers');
    providersModule.AliasProvider = jest.fn().mockImplementation(() => mockAliasProvider);

    const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const provider = new FumeMappingProvider({ fhirClient: mockClient, logger });
    await provider.initialize();

    const aliases = provider.getAliases();
    expect(aliases).toEqual({
      ...builtInAliases,
      goodKey: 'ok'
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Invalid server alias key 'bad-key'"));
  });
});
