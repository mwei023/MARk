const responseCache = new Map<string, { response: string; timestamp: number }>();
const CACHE_TTL = 60_000; // 60 seconds

export const getCached = (key: string): string | null => {
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.response;
  }
  return null;
};

export const setCached = (key: string, response: string) => {
  responseCache.set(key, { response, timestamp: Date.now() });
};