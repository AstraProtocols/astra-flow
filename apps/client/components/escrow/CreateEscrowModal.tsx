"use client";

import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { CreateEscrowForm } from "@/components/escrow/CreateEscrowForm";

interface CreateEscrowModalProps {
  open: boolean;
  onClose: () => void;
}

export function CreateEscrowModal({ open, onClose }: CreateEscrowModalProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            className="w-full max-w-2xl rounded-3xl border border-white/10 bg-midnight p-6 shadow-glow"
          >
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-cyan">New escrow</p>
                <h2 className="mt-1 text-2xl font-semibold text-white">Configure milestone settlement</h2>
              </div>
              <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-white/5">
                <X className="h-5 w-5" />
              </button>
            </div>
            <CreateEscrowForm onCreated={onClose} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
