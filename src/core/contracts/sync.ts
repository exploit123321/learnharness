/** PC ↔ phone sync status, as GET/POST /api/sync report it (Settings → Sync). */
export interface SyncStatus {
	/** Sync is set up on this device (address + passphrase keys saved). */
	configured: boolean;
	/** The sync service's address (the LearnHarness Cloudflare site). */
	url: string | null;
	running: boolean;
	/** Last successful pass (ms epoch), or null. */
	lastSyncAt: number | null;
	/** The last pass's error, cleared by the next success. */
	lastError: string | null;
	/** What the last pass moved: files sent, received, and waiting (busy). */
	lastChanges: { sent: number; received: number; waiting: number } | null;
}
