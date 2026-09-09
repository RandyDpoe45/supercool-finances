import type { Config } from 'jest';

/** Unit test config. Tests live in `tests/` (segregated from `src/`, per CLAUDE.md). */
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/tests/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.e2e-spec\\.ts$'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }],
  },
  clearMocks: true,
  // The DB-backed honest-SKIP integration suites each boot AppModule with
  // migrationsRun:true against ONE shared `balance` DB. Run in parallel workers on a
  // FRESH DB they race the CREATE TYPE/CREATE TABLE in MigrationExecutor and can
  // collide (already-exists / deadlock / tuple concurrently updated). Serialize ONLY
  // the opted-in integration run; leave the default unit run parallel. (Set the key
  // conditionally — Jest rejects an explicit `maxWorkers: undefined`.)
  ...(process.env.BALANCE_INTEGRATION === '1' ? { maxWorkers: 1 } : {}),
};

export default config;
