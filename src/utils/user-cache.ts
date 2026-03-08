/**
 * User Service Cache
 * Generic factory for caching per-user service instances
 */

/**
 * Create a user-based service cache
 * @param factory - Async function that creates a service
 * @returns Cache object with get, clear, closeAll methods
 */
export function createUserCache<T>(factory: (userId: number) => T | Promise<T>) {
  const cache = new Map<number, T>();

  return {
    /**
     * Get service for user (create if not exists)
     */
    async get(userId: number): Promise<T> {
      let instance = cache.get(userId);
      if (!instance) {
        instance = await factory(userId);
        cache.set(userId, instance);
      }
      return instance;
    },

    /**
     * Sync version (use when factory is sync)
     */
    getSync(userId: number): T {
      let instance = cache.get(userId);
      if (!instance) {
        const result = factory(userId);
        if (result instanceof Promise) {
          throw new Error("Factory is async, use get() instead");
        }
        instance = result;
        cache.set(userId, instance);
      }
      return instance;
    },

    /**
     * Clear a specific user's cache
     */
    clear(userId: number): boolean {
      return cache.delete(userId);
    },

    /**
     * Clear entire cache
     */
    clearAll(): void {
      cache.clear();
    },

    /**
     * Return all instances (for cleanup)
     */
    values(): IterableIterator<T> {
      return cache.values();
    },

    /**
     * Cache size
     */
    get size(): number {
      return cache.size;
    },

    /**
     * Does user exist?
     */
    has(userId: number): boolean {
      return cache.has(userId);
    },

    /**
     * All entries (userId, instance)
     */
    entries(): IterableIterator<[number, T]> {
      return cache.entries();
    },
  };
}

/**
 * Cache for closeable services (services with a close method)
 */
export function createCloseableUserCache<T extends { close: () => void }>(
  factory: (userId: number) => T | Promise<T>
) {
  const cache = new Map<number, T>();

  const baseGet = async (userId: number): Promise<T> => {
    let instance = cache.get(userId);
    if (!instance) {
      instance = await factory(userId);
      cache.set(userId, instance);
    }
    return instance;
  };

  return {
    get: baseGet,

    getSync(userId: number): T {
      let instance = cache.get(userId);
      if (!instance) {
        const result = factory(userId);
        if (result instanceof Promise) {
          throw new Error("Factory is async, use get() instead");
        }
        instance = result;
        cache.set(userId, instance);
      }
      return instance;
    },

    clear(userId: number): boolean {
      return cache.delete(userId);
    },

    clearAll(): void {
      cache.clear();
    },

    values(): IterableIterator<T> {
      return cache.values();
    },

    get size(): number {
      return cache.size;
    },

    has(userId: number): boolean {
      return cache.has(userId);
    },

    entries(): IterableIterator<[number, T]> {
      return cache.entries();
    },

    /**
     * Close a specific user and remove from cache
     */
    close(userId: number): boolean {
      const instance = cache.get(userId);
      if (instance) {
        instance.close();
        return cache.delete(userId);
      }
      return false;
    },

    /**
     * Close all instances and clear cache
     */
    closeAll(): void {
      for (const instance of cache.values()) {
        instance.close();
      }
      cache.clear();
    },
  };
}
