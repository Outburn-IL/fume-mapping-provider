import { structureMapToExpression, expressionToStructureMap } from '../../src/converters';
import { StructureMap } from '../../src/types';

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
