/**
 * A Cloudflare D1 stand-in over Node's built-in SQLite, for running the sync
 * Worker (cloud/sync-worker.ts) in-process in tests and the phone smoke.
 */
import { DatabaseSync } from "node:sqlite";
import type { D1Like, D1Statement } from "../cloud/sync-worker.ts";

type Exec = { exec(): void };

export function fakeD1(): D1Like & { raw: DatabaseSync } {
	const db = new DatabaseSync(":memory:");
	const norm = (args: unknown[]) => args.map((a) => (typeof a === "boolean" ? Number(a) : a)) as never[];
	const statement = (sql: string, args: unknown[] = []): D1Statement & Exec => ({
		bind: (...values: unknown[]) => statement(sql, values),
		first: async <T>() => ((db.prepare(sql).get(...norm(args)) as T | undefined) ?? null),
		all: async <T>() => ({ results: db.prepare(sql).all(...norm(args)) as T[] }),
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...norm(args)).changes) } }),
		exec: () => void db.prepare(sql).run(...norm(args)),
	});
	return {
		raw: db,
		prepare: (sql: string) => statement(sql),
		batch: async (statements: D1Statement[]) => {
			db.exec("BEGIN");
			try {
				for (const s of statements) (s as D1Statement & Exec).exec();
				db.exec("COMMIT");
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
			return [];
		},
	};
}
