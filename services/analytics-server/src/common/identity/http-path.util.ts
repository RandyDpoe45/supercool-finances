/** First non-empty path segment, e.g. `/admin/whoami` -> `admin`. */
export function firstSegment(path: string): string {
  return path.split('/').filter(Boolean)[0] ?? '';
}

/**
 * Lowercased first path segment, for GUARD PREFIX MATCHING only. Express routes
 * case-insensitively by default, so `/INTERNAL/ping` reaches `InternalController`;
 * the guards must therefore recognize a mixed-case prefix and fail CLOSED (still
 * demand the credential) rather than match case-sensitively and skip the check.
 */
export function prefixSegment(path: string): string {
  return firstSegment(path).toLowerCase();
}

/** Path without a trailing slash (except the root), e.g. `/internal/health/` -> `/internal/health`. */
export function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1);
  }
  return path;
}

/** First value of a header that Express may expose as `string | string[] | undefined`. */
export function headerValue(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
