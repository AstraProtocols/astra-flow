import { Router } from "express";
import { listEscrowsForAddress } from "../services/escrow-indexer.js";

export const escrowRouter = Router();

escrowRouter.get("/:address", (req, res) => {
  const address = req.params.address?.trim();
  if (!address) {
    res.status(400).json({ error: "address is required" });
    return;
  }

  const escrows = listEscrowsForAddress(address).map((escrow) => ({
    ...escrow,
    lockedBalance: escrow.lockedBalance.toString(),
    config: {
      ...escrow.config,
      totalAmount: escrow.config.totalAmount.toString(),
    },
    milestones: escrow.milestones.map((milestone) => ({
      ...milestone,
      payoutAmount: milestone.payoutAmount.toString(),
      completedAt: milestone.completedAt.toString(),
    })),
  }));

  res.json({
    address,
    count: escrows.length,
    active: escrows.filter((item) => item.state === "Active" || item.state === "Disputed"),
    historical: escrows.filter((item) => item.state === "Completed" || item.state === "Cancelled"),
    escrows,
  });
});
