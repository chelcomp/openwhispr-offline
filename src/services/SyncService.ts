// Cloud sync disabled — local-only stub

class SyncService {
  canSync(): boolean {
    return false;
  }

  startAutoSync(): void {}

  async syncAll(_waitForLock = false): Promise<void> {}

  requestSyncAll(_reason: "start" | "focus" | "interval" | "online" | "manual"): void {}

  async syncDictionaryNow(): Promise<void> {}

  async syncSnippetsNow(): Promise<void> {}

  debouncedPush(_entityType: string, _entityId: number): void {}
}

export const syncService = new SyncService();
