/** @type {import('jest').Config} */
const tsJest = ['ts-jest', { tsconfig: 'tsconfig.json' }];

const base = {
  moduleFileExtensions: ['ts', 'js', 'json'],
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': tsJest },
};

module.exports = {
  testTimeout: 120_000,
  projects: [
    {
      ...base,
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
    },
    {
      ...base,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts', '!src/worker.ts', '!src/database/migrations/**'],
  coverageDirectory: 'coverage',
};
