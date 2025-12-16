import { structureMapToExpression, expressionToStructureMap, conceptMapToAliasObject, aliasObjectToConceptMap } from '../../src/converters';
import { StructureMap, ConceptMap, AliasObject } from '../../src/types';

describe('structureMapToExpression', () => {
  it('should extract expression from a valid StructureMap', () => {
    const structureMap: StructureMap = {
      resourceType: 'StructureMap',
      id: 'test-mapping',
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
                    expression: 'testExpression = input.value'
                  }
                }
              ]
            }
          ]
        }
      ]
    };

    const result = structureMapToExpression(structureMap);
    expect(result).toBe('testExpression = input.value');
  });

  it('should return null when no groups exist', () => {
    const structureMap: StructureMap = {
      resourceType: 'StructureMap',
      id: 'test-mapping'
    };

    const result = structureMapToExpression(structureMap);
    expect(result).toBeNull();
  });

  it('should return null when no rules exist', () => {
    const structureMap: StructureMap = {
      resourceType: 'StructureMap',
      id: 'test-mapping',
      group: [
        {
          name: 'fumeMapping'
        }
      ]
    };

    const result = structureMapToExpression(structureMap);
    expect(result).toBeNull();
  });

  it('should return null when no extensions exist', () => {
    const structureMap: StructureMap = {
      resourceType: 'StructureMap',
      id: 'test-mapping',
      group: [
        {
          name: 'fumeMapping',
          rule: [
            {
              name: 'someRule'
            }
          ]
        }
      ]
    };

    const result = structureMapToExpression(structureMap);
    expect(result).toBeNull();
  });

  it('should return null when expression extension is not found', () => {
    const structureMap: StructureMap = {
      resourceType: 'StructureMap',
      id: 'test-mapping',
      group: [
        {
          name: 'fumeMapping',
          rule: [
            {
              extension: [
                {
                  url: 'http://example.com/some-other-extension',
                  valueExpression: {
                    expression: 'someExpression'
                  }
                }
              ]
            }
          ]
        }
      ]
    };

    const result = structureMapToExpression(structureMap);
    expect(result).toBeNull();
  });
});

describe('expressionToStructureMap', () => {
  it('should create a valid StructureMap from expression with default canonical', () => {
    const mappingId = 'test-mapping';
    const expression = 'result = input.value * 2';

    const result = expressionToStructureMap(mappingId, expression);

    expect(result.resourceType).toBe('StructureMap');
    expect(result.id).toBe(mappingId);
    expect(result.name).toBe(mappingId);
    expect(result.title).toBe(mappingId);
    expect(result.status).toBe('active');
    expect(result.url).toBe(`http://example.com/StructureMap/${mappingId}`);
    expect(result.group).toHaveLength(1);
    expect(result.group![0].rule).toHaveLength(1);
    expect(result.group![0].rule![0].extension).toHaveLength(1);
    expect(result.group![0].rule![0].extension![0].valueExpression?.expression).toBe(expression);
  });

  it('should create a StructureMap with custom canonical base URL', () => {
    const mappingId = 'custom-mapping';
    const expression = 'output = input';
    const canonicalBase = 'https://custom.example.org';

    const result = expressionToStructureMap(mappingId, expression, canonicalBase);

    expect(result.url).toBe(`${canonicalBase}/StructureMap/${mappingId}`);
    expect(result.identifier).toHaveLength(1);
    expect(result.identifier![0].value).toBe(`${canonicalBase}/StructureMap/${mappingId}`);
  });

  it('should include proper FUME useContext', () => {
    const result = expressionToStructureMap('test', 'expr');

    expect(result.useContext).toHaveLength(1);
    expect(result.useContext![0].valueCodeableConcept?.coding).toHaveLength(1);
    expect(result.useContext![0].valueCodeableConcept?.coding![0].system).toBe('http://codes.fume.health');
    expect(result.useContext![0].valueCodeableConcept?.coding![0].code).toBe('fume');
  });

  it('should set proper date', () => {
    const before = new Date().getTime();
    const result = expressionToStructureMap('test', 'expr');
    const after = new Date().getTime();
    const resultDate = new Date(result.date!).getTime();

    expect(result.date).toBeDefined();
    expect(resultDate).toBeGreaterThanOrEqual(before);
    expect(resultDate).toBeLessThanOrEqual(after);
  });
});

describe('round-trip conversion', () => {
  it('should maintain expression through conversion', () => {
    const originalExpression = 'complex.expression = input.deeply.nested.value';
    const structureMap = expressionToStructureMap('test', originalExpression);
    const extractedExpression = structureMapToExpression(structureMap);

    expect(extractedExpression).toBe(originalExpression);
  });
});

describe('conceptMapToAliasObject', () => {
  it('should convert a valid ConceptMap to alias object', () => {
    const conceptMap: ConceptMap = {
      resourceType: 'ConceptMap',
      group: [
        {
          element: [
            {
              code: 'key1',
              target: [{ code: 'value1' }]
            },
            {
              code: 'key2',
              target: [{ code: 'value2' }]
            }
          ]
        }
      ]
    };

    const result = conceptMapToAliasObject(conceptMap);
    
    expect(result).toEqual({
      key1: 'value1',
      key2: 'value2'
    });
  });

  it('should return empty object when no groups exist', () => {
    const conceptMap: ConceptMap = {
      resourceType: 'ConceptMap'
    };

    const result = conceptMapToAliasObject(conceptMap);
    
    expect(result).toEqual({});
  });

  it('should handle multiple groups', () => {
    const conceptMap: ConceptMap = {
      resourceType: 'ConceptMap',
      group: [
        {
          element: [
            { code: 'key1', target: [{ code: 'value1' }] }
          ]
        },
        {
          element: [
            { code: 'key2', target: [{ code: 'value2' }] }
          ]
        }
      ]
    };

    const result = conceptMapToAliasObject(conceptMap);
    
    expect(result).toEqual({
      key1: 'value1',
      key2: 'value2'
    });
  });

  it('should skip elements without code', () => {
    const conceptMap: ConceptMap = {
      resourceType: 'ConceptMap',
      group: [
        {
          element: [
            { code: 'key1', target: [{ code: 'value1' }] },
            { target: [{ code: 'value2' }] } // missing code
          ]
        }
      ]
    };

    const result = conceptMapToAliasObject(conceptMap);
    
    expect(result).toEqual({
      key1: 'value1'
    });
  });

  it('should skip elements without target code', () => {
    const conceptMap: ConceptMap = {
      resourceType: 'ConceptMap',
      group: [
        {
          element: [
            { code: 'key1', target: [{ code: 'value1' }] },
            { code: 'key2' } // missing target
          ]
        }
      ]
    };

    const result = conceptMapToAliasObject(conceptMap);
    
    expect(result).toEqual({
      key1: 'value1'
    });
  });

  it('should warn on duplicate keys', () => {
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    const conceptMap: ConceptMap = {
      resourceType: 'ConceptMap',
      group: [
        {
          element: [
            { code: 'key1', target: [{ code: 'value1' }] },
            { code: 'key1', target: [{ code: 'value2' }] }
          ]
        }
      ]
    };

    const result = conceptMapToAliasObject(conceptMap, mockLogger);
    
    expect(result).toEqual({
      key1: 'value2' // last one wins
    });
    expect(mockLogger.warn).toHaveBeenCalledWith('Duplicate alias key found: key1');
  });
});

describe('aliasObjectToConceptMap', () => {
  it('should create a valid ConceptMap from alias object', () => {
    const aliases: AliasObject = {
      key1: 'value1',
      key2: 'value2'
    };

    const result = aliasObjectToConceptMap(aliases);

    expect(result.resourceType).toBe('ConceptMap');
    expect(result.name).toBe('FumeAliases');
    expect(result.status).toBe('active');
    expect(result.publisher).toBe('Outburn Ltd.');
    expect(result.url).toBe('http://example.com/ConceptMap/fume-global-aliases');
    expect(result.group).toHaveLength(1);
    expect(result.group![0].element).toHaveLength(2);
    expect(result.group![0].element![0].code).toBe('key1');
    expect(result.group![0].element![0].target![0].code).toBe('value1');
    expect(result.group![0].element![0].target![0].equivalence).toBe('equivalent');
  });

  it('should use custom canonical base URL', () => {
    const aliases: AliasObject = { key1: 'value1' };
    const canonicalBase = 'https://custom.example.org';

    const result = aliasObjectToConceptMap(aliases, canonicalBase);

    expect(result.url).toBe(`${canonicalBase}/ConceptMap/fume-global-aliases`);
    expect(result.group![0].source).toBe(`${canonicalBase}/CodeSystem/fume-global-alias-name`);
    expect(result.group![0].target).toBe(`${canonicalBase}/CodeSystem/fume-global-alias-value`);
  });

  it('should include proper FUME useContext', () => {
    const aliases: AliasObject = { key1: 'value1' };
    const result = aliasObjectToConceptMap(aliases);

    expect(result.useContext).toHaveLength(1);
    expect(result.useContext![0].code?.system).toBe('http://snomed.info/sct');
    expect(result.useContext![0].code?.code).toBe('706594005');
    expect(result.useContext![0].valueCodeableConcept?.coding).toHaveLength(1);
    expect(result.useContext![0].valueCodeableConcept?.coding![0].system).toBe('http://codes.fume.health');
    expect(result.useContext![0].valueCodeableConcept?.coding![0].code).toBe('fume');
  });

  it('should update existing ConceptMap', () => {
    const existingConceptMap: ConceptMap = {
      resourceType: 'ConceptMap',
      id: 'existing-id',
      url: 'http://example.com/ConceptMap/fume-global-aliases',
      name: 'FumeAliases',
      status: 'active',
      publisher: 'Outburn Ltd.',
      description: 'The value associated with each FUME alias'
    };

    const aliases: AliasObject = { newKey: 'newValue' };
    const result = aliasObjectToConceptMap(aliases, undefined, existingConceptMap);

    expect(result.id).toBe('existing-id'); // preserved
    expect(result.group![0].element).toHaveLength(1);
    expect(result.group![0].element![0].code).toBe('newKey');
  });

  it('should handle empty alias object', () => {
    const aliases: AliasObject = {};
    const result = aliasObjectToConceptMap(aliases);

    expect(result.group).toHaveLength(1);
    expect(result.group![0].element).toHaveLength(0);
  });

  it('should set proper date', () => {
    const aliases: AliasObject = { key1: 'value1' };
    const before = new Date().getTime();
    const result = aliasObjectToConceptMap(aliases);
    const after = new Date().getTime();
    const resultDate = new Date(result.date!).getTime();

    expect(result.date).toBeDefined();
    expect(resultDate).toBeGreaterThanOrEqual(before);
    expect(resultDate).toBeLessThanOrEqual(after);
  });
});

describe('alias round-trip conversion', () => {
  it('should maintain aliases through conversion', () => {
    const originalAliases: AliasObject = {
      key1: 'value1',
      key2: 'value2',
      key3: 'value3'
    };

    const conceptMap = aliasObjectToConceptMap(originalAliases);
    const extractedAliases = conceptMapToAliasObject(conceptMap);

    expect(extractedAliases).toEqual(originalAliases);
  });
});
