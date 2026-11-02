/**
 * PC ↔ phone sync (Settings → Sync). GET: status. POST {action}:
 *   "enable"  {url, passphrase} — derive keys, check them, first pass
 *   "sync"    — run a pass now (also the phone's foreground trigger)
 *   "disable" — turn sync off on this device
 */
import { disableSync, enableSync, syncNow, syncStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(syncStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { action?: unknown; url?: unknown; passphrase?: unknown };
	switch (body.action) {
		case "enable": {
			if (typeof body.url !== "string" || typeof body.passphrase !== "string") {
				return Response.json({ error: "body must be {action: \"enable\", url, passphrase}" }, { status: 400 });
			}
			const result = await enableSync(body.url, body.passphrase);
			return result.ok ? Response.json(result.status) : Response.json({ error: result.error }, { status: 400 });
		}
		case "sync":
			return Response.json(await syncNow());
		case "disable":
			return Response.json(disableSync());
		default:
			return Response.json({ error: "action must be enable, sync or disable" }, { status: 400 });
	}
}
