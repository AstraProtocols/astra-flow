import { Router } from "express";
import { z } from "zod";
import {
  getEscrowById,
  getEscrowTimeline,
  listEscrows,
  listEscrowsForAddress,
} from "../services/indexer.js";

export const escrowRouter = Router();

const listQuery = z.object({
  address: z.string().min(1).optional(),
  state: z.enum(["Pending", "Active", "Completed", "Disputed", "Cancelled"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

const idParam = z.object({
  id: z.string().min(1),
});

const timelineQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
});

function serializeEscrow(escrow: ReturnType<typeof listEscrows>["items"][number]) {
  return {
    id: escrow.id,
    address: escrow.address,
    role: escrow.role,
    state: escrow.state,
    lockedBalance: escrow.lockedBalance.toString(),
    updatedAt: escrow.updatedAt,
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
  };
}

escrowRouter.get("/", (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid query", details: parsed.error.flatten() });
    return;
  }

  const result = listEscrows(parsed.data);
  res.json({
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    pageCount: Math.max(1, Math.ceil(result.total / result.pageSize)),
    items: result.items.map(serializeEscrow),
  });
});

escrowRouter.get("/:id/timeline", (req, res) => {
  const idParsed = idParam.safeParse(req.params);
  const queryParsed = timelineQuery.safeParse(req.query);
  if (!idParsed.success || !queryParsed.success) {
    res.status(400).json({
      error: "invalid timeline request",
      details: {
        params: idParsed.success ? undefined : idParsed.error.flatten(),
        query: queryParsed.success ? undefined : queryParsed.error.flatten(),
      },
    });
    return;
  }

  const escrow = getEscrowById(idParsed.data.id);
  if (!escrow) {
    res.status(404).json({ error: "escrow not found", id: idParsed.data.id });
    return;
  }

  const timeline = getEscrowTimeline(
    idParsed.data.id,
    queryParsed.data.page,
    queryParsed.data.pageSize,
  );
  res.json({
    id: idParsed.data.id,
    state: escrow.state,
    page: timeline.page,
    pageSize: timeline.pageSize,
    total: timeline.total,
    items: timeline.items,
  });
});

escrowRouter.get("/:id", (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "id is required" });
    return;
  }

  const exact = getEscrowById(parsed.data.id);
  if (exact) {
    res.json({ escrow: serializeEscrow({ ...exact, address: exact.address }) });
    return;
  }

  const matches = listEscrowsForAddress(parsed.data.id);
  if (!matches.length) {
    res.status(404).json({ error: "escrow not found", id: parsed.data.id });
    return;
  }

  res.json({
    address: parsed.data.id,
    count: matches.length,
    active: matches
      .filter((item) => item.state === "Active" || item.state === "Disputed")
      .map(serializeEscrow),
    historical: matches
      .filter((item) => item.state === "Completed" || item.state === "Cancelled")
      .map(serializeEscrow),
    escrows: matches.map(serializeEscrow),
  });
});
