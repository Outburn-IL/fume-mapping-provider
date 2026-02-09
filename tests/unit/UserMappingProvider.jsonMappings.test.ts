import { UserMappingProvider } from '../../src/providers';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from '@outburn/types';

describe('UserMappingProvider JSON mappings', () => {
  const createTempFolder = async () => fs.mkdtemp(path.join(os.tmpdir(), 'fume-mappings-'));

  it('should load *.json files as static JSON values', async () => {
    const folder = await createTempFolder();
    await fs.writeFile(path.join(folder, 'myMap.json'), JSON.stringify({ a: 1, b: true }));

    const provider = new UserMappingProvider(folder, undefined, undefined, '.fume');
    const values = await provider.loadStaticJsonValues();

    const value = values.get('myMap');
    expect(value).toBeDefined();
    expect(value!.sourceType).toBe('file');
    expect(value!.source).toBe(path.resolve(folder, 'myMap.json'));
    expect(value!.value).toEqual({ a: 1, b: true });

    // JSON files are not treated as mappings
    const mappings = await provider.loadMappings();
    expect(mappings.has('myMap')).toBe(false);
  });

  it('should skip reserved aliases.json (never becomes a mapping named aliases)', async () => {
    const folder = await createTempFolder();
    await fs.writeFile(path.join(folder, 'aliases.json'), JSON.stringify({ x: 'y' }));

    const provider = new UserMappingProvider(folder, undefined, undefined, '.fume');
    const mappings = await provider.loadMappings();
    const values = await provider.loadStaticJsonValues();

    expect(mappings.has('aliases')).toBe(false);
    expect(values.has('aliases')).toBe(false);
  });

  it('should keep static JSON values separate from mappings even when keys collide', async () => {
    const folder = await createTempFolder();
    await fs.writeFile(path.join(folder, 'dup.fume'), 'text');
    await fs.writeFile(path.join(folder, 'dup.json'), JSON.stringify({ kind: 'json' }));

    const warn = jest.fn();
    const logger = { warn } as unknown as Logger;

    const provider = new UserMappingProvider(folder, undefined, logger, '.fume');
    const mappings = await provider.loadMappings();
    const values = await provider.loadStaticJsonValues();

    expect(mappings.get('dup')!.sourceType).toBe('file');
    expect(mappings.get('dup')!.source).toBe(path.resolve(folder, 'dup.fume'));
    expect(mappings.get('dup')!.expression).toBe('text');

    expect(values.get('dup')!.sourceType).toBe('file');
    expect(values.get('dup')!.source).toBe(path.resolve(folder, 'dup.json'));
    expect(values.get('dup')!.value).toEqual({ kind: 'json' });

    // No warning is required because they are separate namespaces.
    expect(warn).not.toHaveBeenCalled();
  });

  it('should warn+skip invalid static JSON value files', async () => {
    const folder = await createTempFolder();
    await fs.writeFile(path.join(folder, 'bad.json'), '{ not json');

    const warn = jest.fn();
    const logger = { warn } as unknown as Logger;

    const provider = new UserMappingProvider(folder, undefined, logger, '.fume');
    const values = await provider.loadStaticJsonValues();

    expect(values.has('bad')).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('should allow static JSON keys with underscores or leading digits (generic key regex)', async () => {
    const folder = await createTempFolder();
    await fs.writeFile(path.join(folder, '1a.json'), JSON.stringify(123));
    await fs.writeFile(path.join(folder, '_a.json'), JSON.stringify('x'));

    const provider = new UserMappingProvider(folder, undefined, undefined, '.fume');
    const values = await provider.loadStaticJsonValues();

    expect(values.get('1a')!.value).toBe(123);
    expect(values.get('_a')!.value).toBe('x');
  });
});
