// Export main class
export { FumeMappingProvider } from './FumeMappingProvider';

// Export types
export {
  UserMapping,
  UserMappingMetadata,
  PackageMapping,
  PackageMappingMetadata,
  StructureMap,
  FumeMappingProviderConfig,
  GetPackageMappingOptions
} from './types';

// Export converters
export { structureMapToExpression, expressionToStructureMap } from './converters';

// Export providers (for advanced usage)
export {
  UserMappingProvider,
  PackageMappingProvider
} from './providers';
