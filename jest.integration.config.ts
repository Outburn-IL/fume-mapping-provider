import type { Config } from 'jest';

// NOTE: This config is for running integration tests only.
// Use `npm test` to run all tests (unit + integration) with coverage.
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/integration/**/*.test.ts'],
  testTimeout: 120000, // 2 minutes for integration tests
  globalSetup: '<rootDir>/tests/integration/setup.ts',
  globalTeardown: '<rootDir>/tests/integration/teardown.ts',
  collectCoverage: false,
  verbose: true,
  maxWorkers: 1, // Run integration tests serially
};

export default config;
