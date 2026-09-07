import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqlDialect = "sqlite" | "postgres";

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  changes: number;
}

export interface SqlDatabase {
  readonly dialect: SqlDialect;
  execute<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  transaction<T>(work: (db: SqlDatabase) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
  ping(): Promise<{ ok: true; dialect: SqlDialect; latencyMs: number }>;
  close(): Promise<void>;
}

export interface DatabaseConfig {
  url?: string;
  sqlitePath?: string;
}

const MIGRATIONS: Array<{ id: string; sqlite: string; postgres: string }> = [
  {
    id: "001_schema_migrations",
    sqlite: `CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`,
    postgres: `CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
  },
];

function parseDialect(url: string | undefined, sqlitePath: string | undefined): {
  dialect: SqlDialect;
  sqlitePath: string;
  postgresUrl?: string;
} {
  const connection = url?.trim() || "";
  if (connection.startsWith("postgres://") || connection.startsWith("postgresql://")) {
    return { dialect: "postgres", sqlitePath: ":memory:", postgresUrl: connection };
  }
  if (connection.startsWith("sqlite://")) {
    return { dialect: "sqlite", sqlitePath: connection.replace(/^sqlite:\/\//, "") || ":memory:" };
  }
  return { dialect: "sqlite", sqlitePath: sqlitePath || connection || ":memory:" };
}

function rewritePlaceholders(sql: string, dialect: SqlDialect): string {
  if (dialect === "sqlite") return sql;
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

class SqliteDatabase implements SqlDatabase {
  readonly dialect = "sqlite" as const;
  private readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  async execute<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const trimmed = sql.trim();
    const isSelect = /^(select|pragma|with)\b/i.test(trimmed);
    if (isSelect) {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...(params as never[])) as T[];
      return { rows, changes: rows.length };
    }
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...(params as never[])) as { changes?: number };
    return { rows: [], changes: result.changes ?? 0 };
  }

  async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const { rows } = await this.execute<T>(sql, params);
    return rows[0];
  }

  async transaction<T>(work: (db: SqlDatabase) => Promise<T>): Promise<T> {
    this.txDepth += 1;
    if (this.txDepth === 1) this.db.exec("BEGIN IMMEDIATE;");
    try {
      const value = await work(this);
      this.txDepth -= 1;
      if (this.txDepth === 0) this.db.exec("COMMIT;");
      return value;
    } catch (error) {
      this.txDepth = 0;
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  async migrate(): Promise<void> {
    for (const migration of MIGRATIONS) {
      this.db.exec(migration.sqlite);
    }
    for (const migration of MIGRATIONS) {
      const existing = this.db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(migration.id);
      if (!existing) {
        this.db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
          migration.id,
          new Date().toISOString(),
        );
      }
    }
  }

  async ping(): Promise<{ ok: true; dialect: SqlDialect; latencyMs: number }> {
    const started = Date.now();
    this.db.prepare("SELECT 1 AS ok").get();
    return { ok: true, dialect: this.dialect, latencyMs: Date.now() - started };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

interface PgQuerier {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
}

class PostgresDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;

  constructor(private readonly client: PgQuerier) {}

  async execute<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const rewritten = rewritePlaceholders(sql, "postgres");
    const result = await this.client.query(rewritten, params);
    return { rows: result.rows as T[], changes: result.rowCount ?? 0 };
  }

  async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const { rows } = await this.execute<T>(sql, params);
    return rows[0];
  }

  async transaction<T>(work: (db: SqlDatabase) => Promise<T>): Promise<T> {
    await this.client.query("BEGIN");
    try {
      const value = await work(this);
      await this.client.query("COMMIT");
      return value;
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async migrate(): Promise<void> {
    for (const migration of MIGRATIONS) {
      await this.client.query(migration.postgres);
      const existing = await this.client.query("SELECT id FROM schema_migrations WHERE id = $1", [
        migration.id,
      ]);
      if (existing.rows.length === 0) {
        await this.client.query("INSERT INTO schema_migrations (id, applied_at) VALUES ($1, NOW())", [
          migration.id,
        ]);
      }
    }
  }

  async ping(): Promise<{ ok: true; dialect: SqlDialect; latencyMs: number }> {
    const started = Date.now();
    await this.client.query("SELECT 1 AS ok");
    return { ok: true, dialect: this.dialect, latencyMs: Date.now() - started };
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

async function connectPostgres(url: string): Promise<PostgresDatabase> {
  let loaded: { Client: new (config: { connectionString: string }) => PgQuerier & { connect(): Promise<void> } };
  try {
    loaded = (await import("pg")) as unknown as typeof loaded;
  } catch (error) {
    throw new Error(
      "PostgreSQL support requires the `pg` package. Install it or use a sqlite:// DATABASE_URL.",
      { cause: error },
    );
  }
  const client = new loaded.Client({ connectionString: url });
  await client.connect();
  return new PostgresDatabase(client);
}

export async function createDatabase(config: DatabaseConfig = {}): Promise<SqlDatabase> {
  const parsed = parseDialect(
    config.url ?? process.env.DATABASE_URL,
    config.sqlitePath ?? process.env.INDEXER_DB_PATH,
  );
  if (parsed.dialect === "postgres" && parsed.postgresUrl) {
    const db = await connectPostgres(parsed.postgresUrl);
    await db.migrate();
    return db;
  }
  const db = new SqliteDatabase(parsed.sqlitePath);
  await db.migrate();
  return db;
}

let singleton: Promise<SqlDatabase> | undefined;

export function getDatabase(): Promise<SqlDatabase> {
  if (!singleton) {
    singleton = createDatabase();
  }
  return singleton;
}

export async function resetDatabaseSingleton(): Promise<void> {
  if (!singleton) return;
  const db = await singleton;
  await db.close();
  singleton = undefined;
}
