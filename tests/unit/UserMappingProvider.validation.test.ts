import { UserMappingProvider } from '../../src/providers';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from '@outburn/types';

describe('UserMappingProvider mapping name validation', () => {
  const createTempFolder = async () => fs.mkdtemp(path.join(os.tmpdir(), 'fume-mappings-'));

  it('should warn+skip invalid file mapping names', async () => {
    const folder = await createTempFolder();

    await fs.writeFile(path.join(folder, 'goodOne.fume'), 'expr');
    await fs.writeFile(path.join(folder, 'bad-name.fume'), 'expr');
    await fs.writeFile(path.join(folder, '_bad.fume'), 'expr');
    await fs.writeFile(path.join(folder, '1bad.fume'), 'expr');

    const warn = jest.fn();
    const logger = { warn } as unknown as Logger;
    const provider = new UserMappingProvider(folder, undefined, logger);

    const mappings = await provider.loadMappings();

    expect(Array.from(mappings.keys())).toEqual(['goodOne']);
    expect(warn).toHaveBeenCalled();
  });

  it('should warn+skip invalid server mapping ids', async () => {
    const warn = jest.fn();

    const fhirClient = {
      getBaseUrl: () => 'http://test.com',
      search: async () => [
        {
          resourceType: 'StructureMap',
          id: 'goodId',
          group: [
            {
              rule: [
                {
                  extension: [
                    {
                      url: 'http://fhir.fume.health/StructureDefinition/mapping-expression',
                      valueExpression: { expression: 'x' }
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          resourceType: 'StructureMap',
          id: 'bad-id',
          group: [
            {
              rule: [
                {
                  extension: [
                    {
                      url: 'http://fhir.fume.health/StructureDefinition/mapping-expression',
                      valueExpression: { expression: 'y' }
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const logger = { warn } as unknown as Logger;
    const provider = new UserMappingProvider(undefined, fhirClient as unknown, logger);
    const mappings = await provider.loadMappings();

    expect(mappings.has('goodId')).toBe(true);
    expect(mappings.has('bad-id')).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
