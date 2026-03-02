export interface ISingleton<T> {
  getInstance(): T;
  resetInstance(): void;
}

export function createSingleton<T>(factory: () => T): ISingleton<T> {
  let instance: T | null = null;

  return {
    getInstance(): T {
      if (!instance) {
        instance = factory();
      }
      return instance;
    },
    resetInstance(): void {
      instance = null;
    },
  };
}
