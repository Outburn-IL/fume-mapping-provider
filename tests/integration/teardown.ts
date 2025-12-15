// Teardown - keeping HAPI container running for faster subsequent test runs
// To manually stop: docker-compose -f tests/integration/docker-compose.yml down -v

export default async function globalTeardown() {
  console.log('Tests complete. HAPI FHIR server left running for next test run.');
  console.log('To stop manually: docker stop fume-mapping-provider-test-hapi');
}
