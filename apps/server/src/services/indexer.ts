import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ContractEventWatcher, type AstraFlowEvent, type EscrowState, type Milestone, type MilestoneStatus } from "@astraprotocols/sdk";
import { loadEnv } from "../lib/env.js";

export interface IndexedEscrow {
  id: string;
  address: string;
  role: "funder" | "recipient" | "arbitrator";
  state: EscrowState;
  config: {
    funder: string;
    recipient: string;
    arbitrator: string;
    asset: string;
    totalAmount: bigint;
    releaseThreshold: number;
    lockSecs?: bigint;
  };
  milestones: Milestone[];
  lockedBalance: bigint;
  updatedAt: string;
}

export interface TimelineEntry {
  id: number;
  escrowId: string;
  topic: string;
  ledger: number | null;
  txHash: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface EscrowListQuery {
  address?: string;
  state?: EscrowState;
  page?: number;
  pageSize?: number;
}

interface SqliteStatement {
  run(...params: unknown[]): { changes: number } | void;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS escrows (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  funder TEXT NOT NULL,
  recipient TEXT NOT NULL,
  arbitrator TEXT NOT NULL,
  asset TEXT NOT NULL,
  total_amount TEXT NOT NULL,
  locked_balance TEXT NOT NULL,
  release_threshold INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  escrow_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  ledger INTEGER,
  tx_hash TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_escrows_funder ON escrows(funder);
CREATE INDEX IF NOT EXISTS idx_escrows_recipient ON escrows(recipient);
CREATE INDEX IF NOT EXISTS idx_timeline_escrow ON timeline(escrow_id, id);
`;

function isoNow(): string {
  return new Date().toISOString();
}

function roleFor(address: string, escrow: IndexedEscrow): IndexedEscrow["role"] {
  if (address === escrow.config.recipient) return "recipient";
  if (address === escrow.config.arbitrator) return "arbitrator";
  return "funder";
}

function openDatabase(path: string): SqliteDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new DatabaseSync(path) as unknown as SqliteDatabase;
  sqlite.exec(SCHEMA);
  return sqlite;
}

function serializeEscrow(escrow: IndexedEscrow): string {
  return JSON.stringify({
    ...escrow,
    lockedBalance: escrow.lockedBalance.toString(),
    config: {
      ...escrow.config,
      totalAmount: escrow.config.totalAmount.toString(),
      lockSecs: escrow.config.lockSecs?.toString(),
    },
    milestones: escrow.milestones.map((milestone) => ({
      ...milestone,
      payoutAmount: milestone.payoutAmount.toString(),
      completedAt: milestone.completedAt.toString(),
      submittedAt: milestone.submittedAt?.toString(),
    })),
  });
}

function deserializeEscrow(row: {
  id: string;
  payload: string;
}): IndexedEscrow {
  const parsed = JSON.parse(row.payload) as Omit<IndexedEscrow, "lockedBalance" | "config" | "milestones"> & {
    lockedBalance: string;
    config: Omit<IndexedEscrow["config"], "totalAmount" | "lockSecs"> & {
      totalAmount: string;
      lockSecs?: string;
    };
    milestones: Array<
      Omit<Milestone, "payoutAmount" | "completedAt" | "submittedAt"> & {
        payoutAmount: string;
        completedAt: string;
        submittedAt?: string;
      }
    >;
  };
  return {
    ...parsed,
    id: row.id,
    address: parsed.address ?? row.id,
    lockedBalance: BigInt(parsed.lockedBalance),
    config: {
      ...parsed.config,
      totalAmount: BigInt(parsed.config.totalAmount),
      lockSecs: parsed.config.lockSecs ? BigInt(parsed.config.lockSecs) : undefined,
    },
    milestones: parsed.milestones.map((milestone) => ({
      ...milestone,
      payoutAmount: BigInt(milestone.payoutAmount),
      completedAt: BigInt(milestone.completedAt),
      submittedAt: milestone.submittedAt ? BigInt(milestone.submittedAt) : undefined,
    })),
  };
}

function seedEscrow(): IndexedEscrow {
  const make = (
    id: number,
    amount: bigint,
    status: MilestoneStatus,
    extras: Partial<Milestone> = {},
  ): Milestone => ({
    milestoneId: id,
    payoutAmount: amount,
    descriptionHash: extras.descriptionHash ?? `0${id}`.repeat(32).slice(0, 64),
    isApproved: status === "Released",
    completedAt: status === "Released" ? 1_700_000_000n : 0n,
    proofHash: extras.proofHash,
    status,
  });

  return {
    id: "demo-escrow",
    address: "demo-escrow",
    role: "funder",
    state: "Active",
    config: {
      funder: "GASCSEEDFUNDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      recipient: "GASCSEEDRECIPIENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      arbitrator: "GASCSEEDARBITRATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      totalAmount: 450_0000000n,
      releaseThreshold: 3,
    },
    milestones: [
      make(1, 150_0000000n, "Released"),
      make(2, 150_0000000n, "Under Review", { proofHash: "ab".repeat(32) }),
      make(3, 150_0000000n, "Pending"),
    ],
    lockedBalance: 300_0000000n,
    updatedAt: isoNow(),
  };
}

class EscrowCache {
  constructor(private readonly db: SqliteDatabase) {
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM escrows").get() as { n: number };
    if (!count?.n) {
      this.upsert(seedEscrow());
    }
  }

  upsert(escrow: IndexedEscrow): void {
    this.db
      .prepare(
        `INSERT INTO escrows (
          id, state, funder, recipient, arbitrator, asset, total_amount,
          locked_balance, release_threshold, payload, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state=excluded.state,
          funder=excluded.funder,
          recipient=excluded.recipient,
          arbitrator=excluded.arbitrator,
          asset=excluded.asset,
          total_amount=excluded.total_amount,
          locked_balance=excluded.locked_balance,
          release_threshold=excluded.release_threshold,
          payload=excluded.payload,
          updated_at=excluded.updated_at`,
      )
      .run(
        escrow.id,
        escrow.state,
        escrow.config.funder,
        escrow.config.recipient,
        escrow.config.arbitrator,
        escrow.config.asset,
        escrow.config.totalAmount.toString(),
        escrow.lockedBalance.toString(),
        escrow.config.releaseThreshold,
        serializeEscrow(escrow),
        escrow.updatedAt,
      );
  }

  get(id: string): IndexedEscrow | undefined {
    const row = this.db.prepare("SELECT id, payload FROM escrows WHERE id = ?").get(id) as
      | { id: string; payload: string }
      | undefined;
    return row ? deserializeEscrow(row) : undefined;
  }

  list(query: EscrowListQuery): { items: IndexedEscrow[]; total: number } {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.address) {
      where.push("(id = ? OR funder = ? OR recipient = ? OR arbitrator = ?)");
      params.push(query.address, query.address, query.address, query.address);
    }
    if (query.state) {
      where.push("state = ?");
      params.push(query.state);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM escrows ${clause}`)
      .get(...params) as { n: number };
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM escrows ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as Array<{ id: string; payload: string }>;

    const items = rows.map((row) => {
      const escrow = deserializeEscrow(row);
      if (query.address) {
        return { ...escrow, address: query.address, role: roleFor(query.address, escrow) };
      }
      return escrow;
    });
    return { items, total: totalRow?.n ?? 0 };
  }

  appendTimeline(entry: Omit<TimelineEntry, "id">): TimelineEntry {
    this.db
      .prepare(
        `INSERT INTO timeline (escrow_id, topic, ledger, tx_hash, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.escrowId,
        entry.topic,
        entry.ledger,
        entry.txHash,
        JSON.stringify(entry.payload),
        entry.createdAt,
      );
    const row = this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
    return { ...entry, id: row.id };
  }

  timeline(escrowId: string, page = 1, pageSize = 50): { items: TimelineEntry[]; total: number } {
    const size = Math.min(100, Math.max(1, pageSize));
    const offset = (Math.max(1, page) - 1) * size;
    const totalRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM timeline WHERE escrow_id = ?")
      .get(escrowId) as { n: number };
    const rows = this.db
      .prepare(
        `SELECT id, escrow_id, topic, ledger, tx_hash, payload, created_at
         FROM timeline WHERE escrow_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(escrowId, size, offset) as Array<{
      id: number;
      escrow_id: string;
      topic: string;
      ledger: number | null;
      tx_hash: string | null;
      payload: string;
      created_at: string;
    }>;
    return {
      total: totalRow?.n ?? 0,
      items: rows.map((row) => ({
        id: row.id,
        escrowId: row.escrow_id,
        topic: row.topic,
        ledger: row.ledger,
        txHash: row.tx_hash,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        createdAt: row.created_at,
      })),
    };
  }

  setCursor(cursor: string): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES('cursor', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(cursor);
  }

  getCursor(): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'cursor'").get() as
      | { value: string }
      | undefined;
    return row?.value;
  }
}

let cache: EscrowCache | undefined;
let watcher: ContractEventWatcher | undefined;

function getCache(): EscrowCache {
  if (!cache) {
    const env = loadEnv();
    const path = env.INDEXER_DB_PATH;
    cache = new EscrowCache(openDatabase(path));
  }
  return cache;
}

function applyEvent(event: AstraFlowEvent): void {
  const store = getCache();
  const existing = store.get(event.contractId);
  const escrow: IndexedEscrow = existing ?? {
    id: event.contractId,
    address: event.contractId,
    role: "funder",
    state: "Active",
    config: {
      funder: "",
      recipient: "",
      arbitrator: "",
      asset: "",
      totalAmount: 0n,
      releaseThreshold: 0,
    },
    milestones: [],
    lockedBalance: 0n,
    updatedAt: isoNow(),
  };

  switch (event.topic) {
    case "ProofSubmitted": {
      escrow.milestones = upsertMilestone(escrow.milestones, event.milestoneId, {
        status: "Under Review",
        proofHash: event.proofHash,
        submittedAt: event.at,
      });
      break;
    }
    case "MilestoneReleased": {
      escrow.milestones = upsertMilestone(escrow.milestones, event.milestoneId, {
        status: "Released",
        isApproved: true,
        completedAt: BigInt(event.ledger ?? 0),
      });
      escrow.lockedBalance = escrow.lockedBalance > event.amount ? escrow.lockedBalance - event.amount : 0n;
      if (escrow.milestones.every((item) => item.status === "Released")) {
        escrow.state = "Completed";
      }
      break;
    }
    case "DisputeRaised":
      escrow.state = "Disputed";
      escrow.milestones = escrow.milestones.map((item) =>
        item.status === "Released" ? item : { ...item, status: "Disputed" },
      );
      break;
    case "DisputeResolved":
      escrow.state = "Completed";
      escrow.lockedBalance = 0n;
      break;
    default:
      break;
  }

  escrow.updatedAt = isoNow();
  store.upsert(escrow);
  store.appendTimeline({
    escrowId: event.contractId,
    topic: event.topic,
    ledger: event.ledger ?? null,
    txHash: event.txHash ?? null,
    payload: JSON.parse(
      JSON.stringify(event, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
    ) as Record<string, unknown>,
    createdAt: isoNow(),
  });
}

function upsertMilestone(
  milestones: Milestone[],
  milestoneId: number,
  patch: Partial<Milestone>,
): Milestone[] {
  const exists = milestones.some((item) => item.milestoneId === milestoneId);
  if (!exists) {
    return [
      ...milestones,
      {
        milestoneId,
        payoutAmount: 0n,
        descriptionHash: "",
        isApproved: false,
        completedAt: 0n,
        status: "Pending" as MilestoneStatus,
        ...patch,
      },
    ].sort((a, b) => a.milestoneId - b.milestoneId);
  }
  return milestones.map((item) => (item.milestoneId === milestoneId ? { ...item, ...patch } : item));
}

export function listEscrows(query: EscrowListQuery = {}): { items: IndexedEscrow[]; total: number; page: number; pageSize: number } {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const result = getCache().list({ ...query, page, pageSize });
  return { ...result, page, pageSize };
}

export function listEscrowsForAddress(address: string): IndexedEscrow[] {
  const { items } = listEscrows({ address, page: 1, pageSize: 100 });
  if (items.length) return items;
  const demo = getCache().get("demo-escrow");
  if (!demo) return [];
  return [{ ...demo, address, role: "funder", config: { ...demo.config, funder: address } }];
}

export function getEscrowById(id: string): IndexedEscrow | undefined {
  return getCache().get(id);
}

export function getEscrowTimeline(
  id: string,
  page = 1,
  pageSize = 50,
): { items: TimelineEntry[]; total: number; page: number; pageSize: number } {
  const result = getCache().timeline(id, page, pageSize);
  return { ...result, page, pageSize };
}

export function recordProof(address: string, milestoneId: number, proofHash: string): IndexedEscrow {
  const store = getCache();
  const current =
    store.get(address) ??
    listEscrowsForAddress(address)[0] ??
    seedEscrow();
  const next: IndexedEscrow = {
    ...current,
    id: current.id === "demo-escrow" ? address : current.id,
    address,
    milestones: upsertMilestone(current.milestones, milestoneId, {
      proofHash,
      status: "Under Review",
      submittedAt: BigInt(Math.floor(Date.now() / 1000)),
    }),
    updatedAt: isoNow(),
  };
  store.upsert(next);
  store.appendTimeline({
    escrowId: next.id,
    topic: "ProofSubmitted",
    ledger: null,
    txHash: null,
    payload: { milestoneId, proofHash, source: "github-webhook" },
    createdAt: isoNow(),
  });
  return next;
}

export async function startIndexer(): Promise<void> {
  const env = loadEnv();
  getCache();
  if (!env.ESCROW_CONTRACT_ID || watcher) return;
  watcher = new ContractEventWatcher({
    contractId: env.ESCROW_CONTRACT_ID,
    network: env.STELLAR_NETWORK,
    rpcUrl: env.SOROBAN_RPC_URL,
    pollIntervalMs: env.INDEXER_POLL_MS,
  });
  watcher.on(applyEvent);
  await watcher.start();
}

export function stopIndexer(): void {
  watcher?.stop();
  watcher = undefined;
}
