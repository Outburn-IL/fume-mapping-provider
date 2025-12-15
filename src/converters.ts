import { StructureMap } from './types';

const DEFAULT_CANONICAL_BASE = 'http://example.com';
const FUME_EXPRESSION_EXTENSION_URL = 'http://fhir.fume.health/StructureDefinition/mapping-expression';

/**
 * Extracts the FUME expression from a StructureMap resource
 * @param structureMap - The StructureMap resource
 * @returns The FUME expression or null if not found
 */
export function structureMapToExpression(structureMap: StructureMap): string | null {
  if (!structureMap.group || structureMap.group.length === 0) {
    return null;
  }

  for (const group of structureMap.group) {
    if (!group.rule || group.rule.length === 0) {
      continue;
    }

    for (const rule of group.rule) {
      if (!rule.extension || rule.extension.length === 0) {
        continue;
      }

      for (const ext of rule.extension) {
        if (ext.url === FUME_EXPRESSION_EXTENSION_URL && ext.valueExpression?.expression) {
          return ext.valueExpression.expression;
        }
      }
    }
  }

  return null;
}

/**
 * Creates a StructureMap resource from a FUME expression
 * @param mappingId - The mapping identifier
 * @param expression - The FUME expression
 * @param canonicalBaseUrl - Base URL for canonical references (defaults to example.com)
 * @returns A StructureMap resource
 */
export function expressionToStructureMap(
  mappingId: string,
  expression: string,
  canonicalBaseUrl: string = DEFAULT_CANONICAL_BASE
): StructureMap {
  const canonical = `${canonicalBaseUrl}/StructureMap/${mappingId}`;
  const date = new Date().toISOString();

  return {
    resourceType: 'StructureMap',
    id: mappingId,
    url: canonical,
    identifier: [
      {
        use: 'official',
        type: {
          text: 'Canonical URL'
        },
        system: 'urn:ietf:rfc:3986',
        value: canonical
      }
    ],
    name: mappingId,
    title: mappingId,
    status: 'active',
    date,
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
        input: [
          {
            name: 'input',
            mode: 'source'
          }
        ],
        rule: [
          {
            extension: [
              {
                url: FUME_EXPRESSION_EXTENSION_URL,
                valueExpression: {
                  language: 'application/vnd.outburn.fume',
                  expression
                }
              }
            ],
            name: 'evaluate',
            source: [
              {
                context: 'input'
              }
            ]
          }
        ]
      }
    ]
  };
}
