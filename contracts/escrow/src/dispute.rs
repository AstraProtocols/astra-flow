use soroban_sdk::{Address, BytesN, Env};

use crate::storage::{self, EvidenceEntry, EscrowState, MAX_EVIDENCE};
use crate::Error;

/// Append a SHA-256 (or equivalent 32-byte) content hash to the live dispute docket.
/// Only the funder or recipient may write, and only while the escrow is disputed
/// and unresolved. Duplicate hashes are rejected to block replay injection.
pub fn append_dispute_evidence(
    env: &Env,
    actor: Address,
    content_hash: BytesN<32>,
) -> Result<u32, Error> {
    if storage::is_paused(env) {
        return Err(Error::Paused);
    }

    let cfg = storage::get_config(env)?;
    if actor != cfg.funder && actor != cfg.recipient {
        return Err(Error::NotAuthorized);
    }
    actor.require_auth();

    if storage::get_state(env)? != EscrowState::Disputed {
        return Err(Error::BadState);
    }
    let dispute = storage::get_dispute(env)?;
    if dispute.resolved {
        return Err(Error::AlreadyPaid);
    }

    let zero = BytesN::from_array(env, &[0u8; 32]);
    if content_hash == zero {
        return Err(Error::BadAmount);
    }

    let mut entries = storage::get_evidence(env);
    if entries.len() >= MAX_EVIDENCE {
        return Err(Error::Locked);
    }
    for existing in entries.iter() {
        if existing.content_hash == content_hash {
            return Err(Error::DupId);
        }
    }

    entries.push_back(EvidenceEntry {
        submitter: actor,
        content_hash,
        submitted_at: env.ledger().timestamp(),
    });
    let count = entries.len();
    storage::set_evidence(env, &entries);
    Ok(count)
}

pub fn evidence_count(env: &Env) -> u32 {
    storage::get_evidence(env).len()
}
