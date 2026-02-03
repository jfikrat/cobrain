/**
 * User Service Cache
 * Per-user service instance'larını cache'lemek için generic factory
 */

/**
 * User bazlı service cache oluştur
 * @param factory - Service oluşturan async fonksiyon
 * @returns get, clear, closeAll metodları olan cache objesi
 */
export function createUserCache<T>(factory: (userId: number) => T | Promise<T>) {
  const cache = new Map<number, T>();

  return {
    /**
     * User için service al (yoksa oluştur)
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
     * Sync versiyon (factory sync ise kullan)
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
     * Belirli user'ın cache'ini temizle
     */
    clear(userId: number): boolean {
      return cache.delete(userId);
    },

    /**
     * Tüm cache'i temizle
     */
    clearAll(): void {
      cache.clear();
    },

    /**
     * Tüm instance'ları döndür (cleanup için)
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
     * User var mı?
     */
    has(userId: number): boolean {
      return cache.has(userId);
    },

    /**
     * Tüm entries (userId, instance)
     */
    entries(): IterableIterator<[number, T]> {
      return cache.entries();
    },
  };
}

/**
 * Closeable service için cache (close metodu olan service'ler için)
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
     * Belirli user'ı kapat ve cache'den sil
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
     * Tüm instance'ları kapat ve cache'i temizle
     */
    closeAll(): void {
      for (const instance of cache.values()) {
        instance.close();
      }
      cache.clear();
    },
  };
}
