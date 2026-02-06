import { UserMappingProvider } from '../../src/providers';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from '@outburn/types';

describe('UserMappingProvider JSON mappings', () => {
  const createTempFolder = async () => fs.mkdtemp(path.join(os.tmpdir(), 'fume-mappings-'));

  it('should load *.json mappings as parsed JSON values', async () => {
    const folder = await createTempFolder();
    await fs.writeFile(path.join(folder, 'myMap.json'), JSON.stringify({ a: 1, b: true }));

    const provider = new UserMappingProvider(folder, undefined, undefined, '.fume');
    const mappings = await provider.loadMappings();

    const mapping = mappings.get('myMap');
    expect(mapping).toBeDefined();
    expect(mapping!.filename).toBe('myMap.json');
    expect(mapping!.expression).toEqual({ a: 1, b: true });
  });

  it('should skip reserved aliases.json (never becomes a mapping named aliases)', async () => {
    const folder = await createTempFolder();
    await fs.writeFile(path.join(folder, 'aliases.json'), JSON.stringify({ x: 'y' }));

    const provider = new UserMappingProvider(folder, undefined, undefined, '.fume');
    const mappings = await provider.loadMappings();

    expect(mappings.has('aliases')).toBe(false);
  });

  it('should let JSON mapping override text mapping with same key and warn', async () => {
    const folder = await createTempFolder();
    await fs.writeFile(path.join(folder, 'dup.fume'), 'text');
    await fs.writeFile(path.join(folder, 'dup.json'), JSON.stringify({ kind: 'json' }));

    const warn = jest.fn();
    const logger = { warn } as unknown as Logger;

    const provider = new UserMappingProvider(folder, undefined, logger, '.fume');
    const mappings = await provider.loadMappings();

    expect(mappings.get('dup')!.filename).toBe('dup.json');
    expect(mappings.get('dup')!.expression).toEqual({ kind: 'json' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("JSON mapping 'dup' overrides"));
  });

  it('should warn+skip invalid JSON mapping files', async () => {
    const folder = await createTempFolder();
    await fs.writeFile(path.join(folder, 'bad.json'), '{ not json');

    const warn = jest.fn();
    const logger = { warn } as unknown as Logger;

    const provider = new UserMappingProvider(folder, undefined, logger, '.fume');
    const mappings = await provider.loadMappings();

    expect(mappings.has('bad')).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('should allow JSON mapping keys with underscores or leading digits (generic key regex)', async () => {
    const folder = await createTempFolder();
    await fs.writeFile(path.join(folder, '1a.json'), JSON.stringify(123));
    await fs.writeFile(path.join(folder, '_a.json'), JSON.stringify('x'));

    const provider = new UserMappingProvider(folder, undefined, undefined, '.fume');
    const mappings = await provider.loadMappings();

    expect(mappings.get('1a')!.expression).toBe(123);
    expect(mappings.get('_a')!.expression).toBe('x');
  });
});
