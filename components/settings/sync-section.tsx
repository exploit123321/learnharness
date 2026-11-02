"use client";

/**
 * Settings → Sync (owner-approved plan, mobile sync wave): PC ↔ phone sync
 * through the user's own Cloudflare site. Turn on with the site's address
 * and a passphrase (the same on every device); then status, Sync now and
 * Turn off. The passphrase never leaves this device unhashed and is not
 * stored — the server side keeps only keys derived from it.
 */
import { useCallback, useEffect, useState } from "react";
import type { SyncStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function ago(ms: number): string {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	return h < 24 ? `${h} h ago` : new Date(ms).toLocaleString();
}

/** On the phone the app is served by the sync site itself: suggest it. */
function suggestedUrl(): string {
	if (typeof window === "undefined") return "";
	const phone = document.documentElement.classList.contains("lh-phone");
	const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
	return phone && !local && location.protocol === "https:" ? location.origin : "";
}

export function SyncSection() {
	const [status, setStatus] = useState<SyncStatus | null>(null);
	const [url, setUrl] = useState(suggestedUrl);
	const [passphrase, setPassphrase] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			setStatus((await (await fetch("/api/sync")).json()) as SyncStatus);
		} catch {
			// status is informational; the next poll retries
		}
	}, []);

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 5_000);
		return () => clearInterval(timer);
	}, [refresh]);

	const post = async (body: Record<string, string>) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const json = (await res.json()) as SyncStatus & { error?: string };
			if (!res.ok) setError(json.error ?? `HTTP ${res.status}`);
			else {
				setStatus(json);
				if (body.action === "enable") setPassphrase("");
			}
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	if (!status) return <p className="text-xs text-muted-foreground">Loading…</p>;

	if (!status.configured) {
		return (
			<div className="flex flex-col gap-3 text-sm" data-testid="sync-setup">
				<p className="text-muted-foreground">
					Keep your sessions and knowledge graph in step between your PC and phone, through your own LearnHarness Cloudflare site.
					Everything is encrypted with your passphrase before it leaves this device. Settings and API keys stay per device.
				</p>
				<label className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">Sync address (your LearnHarness Cloudflare site)</span>
					<Input
						type="url"
						inputMode="url"
						autoCapitalize="off"
						autoCorrect="off"
						placeholder="https://learnharness.your-name.workers.dev"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						data-testid="sync-url"
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">Passphrase (use the same one on every device)</span>
					<Input
						type="password"
						autoComplete="new-password"
						value={passphrase}
						onChange={(e) => setPassphrase(e.target.value)}
						data-testid="sync-passphrase"
					/>
				</label>
				<Button type="button" disabled={busy || !url || !passphrase} onClick={() => void post({ action: "enable", url, passphrase })} data-testid="sync-enable">
					{busy ? "Turning on…" : "Turn on sync"}
				</Button>
				<p className="text-xs text-muted-foreground">
					The first device sets the passphrase for your site. If you forget it, the synced copy can’t be read — your devices keep their own data.
				</p>
				{error && (
					<p role="alert" className="text-xs text-red-500" data-testid="sync-error">
						{error}
					</p>
				)}
			</div>
		);
	}

	const changes = status.lastChanges;
	return (
		<div className="flex flex-col gap-3 text-sm" data-testid="sync-on">
			<p>
				Syncing with <span className="break-all font-mono text-xs">{status.url}</span>
			</p>
			<p className="text-xs text-muted-foreground" data-testid="sync-status">
				{status.running
					? "Syncing…"
					: status.lastSyncAt
						? `Last synced ${ago(status.lastSyncAt)}${changes ? ` · ${changes.sent} sent, ${changes.received} received${changes.waiting ? `, ${changes.waiting} waiting for a lesson to finish` : ""}` : ""}`
						: "Not synced yet."}
			</p>
			{(error ?? status.lastError) && (
				<p role="alert" className="text-xs text-red-500" data-testid="sync-error">
					{error ?? status.lastError}
				</p>
			)}
			<div className="flex gap-2">
				<Button type="button" variant="outline" disabled={busy || status.running} onClick={() => void post({ action: "sync" })} data-testid="sync-now">
					Sync now
				</Button>
				<Button
					type="button"
					variant="ghost"
					disabled={busy}
					onClick={() => {
						if (window.confirm("Turn off sync on this device? Your data here and the synced copy stay as they are.")) void post({ action: "disable" });
					}}
					data-testid="sync-disable"
				>
					Turn off
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">Syncs when the app opens, after each lesson turn, and every 5 minutes.</p>
		</div>
	);
}
