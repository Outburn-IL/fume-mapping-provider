// Export main class
export { FumeMappingProvider } from './FumeMappingProvider';

// Export types
export {
  UserMapping,
  UserMappingMetadata,
  PackageMapping,
  PackageMappingMetadata,
  StructureMap,
  ConceptMap,
  AliasObject,
  AliasWithMetadata,
  AliasObjectWithMetadata,
  AliasSourceType,
  FumeMappingProviderConfig,
  GetPackageMappingOptions
} from './types';

// Export converters
export {
  structureMapToExpression,
  expressionToStructureMap,
  conceptMapToAliasObject,
  aliasObjectToConceptMap
} from './converters';

// Export providers (for advanced usage)
export {
  UserMappingProvider,
  PackageMappingProvider,
  AliasProvider
} from './providers';
