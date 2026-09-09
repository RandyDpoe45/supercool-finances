/** DI token for the typed {@link AppConfig}. Components inject the interface via
 * this token, never a concrete config source (ADR: depend on interfaces/tokens). */
export const APP_CONFIG = Symbol('APP_CONFIG');
