use soroban_sdk::{Address, Env, Vec};

use crate::access;
use crate::math;
use crate::storage::{self, ArbitratorSet, EscrowState};
use crate::token;
use crate::Error;
use crate::events;

fn member_index(set: &ArbitratorSet, who: &Address) -> Result<u32, Error> {
    for (i, member) in set.members.iter().enumerate() {
        if &member == who {
            return Ok(i as u32);
        }
    }
    Err(Error::NotAuthorized)
}

/// Replace the arbitrator committee. Requires dual funder/recipient approval.
pub fn configure_arbitrators(
    env: &Env,
    members: Vec<Address>,
    threshold: u32,
) -> Result<ArbitratorSet, Error> {
    if storage::is_paused(env) {
        return Err(Error::Paused);
    }
    let cfg = storage::get_config(env)?;
    access::require_dual(&cfg.funder, &cfg.recipient)?;

    let state = storage::get_state(env)?;
    if state != EscrowState::Pending && state != EscrowState::Active {
        return Err(Error::BadState);
    }
    if members.is_empty() || threshold == 0 || threshold > members.len() {
        return Err(Error::QuorumNotMet);
    }

    let mut unique = Vec::<Address>::new(env);
    for member in members.iter() {
        if member == cfg.funder || member == cfg.recipient {
            return Err(Error::ArbitratorCollision);
        }
        for existing in unique.iter() {
            if existing == member {
                return Err(Error::DupId);
            }
        }
        unique.push_back(member.clone());
    }

    let set = ArbitratorSet {
        members: unique,
        threshold,
    };
    storage::set_arbitrators(env, &set);
    Ok(set)
}

/// Settle a dispute once `threshold` distinct committee members have signed.
pub fn settle_with_quorum(
    env: &Env,
    funder_bps: u32,
    recipient_bps: u32,
    signers: Vec<Address>,
) -> Result<(), Error> {
    if storage::is_paused(env) {
        return Err(Error::Paused);
    }
    if storage::get_state(env)? != EscrowState::Disputed {
        return Err(Error::BadState);
    }
    math::require_full_bps(funder_bps, recipient_bps)?;

    let mut dispute = storage::get_dispute(env)?;
    if dispute.resolved {
        return Err(Error::AlreadyPaid);
    }

    let set = storage::get_arbitrators(env)?;
    if (signers.len() as u32) < set.threshold {
        return Err(Error::QuorumNotMet);
    }

    let mut unique = Vec::<Address>::new(env);
    for signer in signers.iter() {
        member_index(&set, &signer)?;
        for existing in unique.iter() {
            if existing == signer {
                return Err(Error::DupId);
            }
        }
        unique.push_back(signer.clone());
    }
    access::require_quorum(&unique, set.threshold)?;

    let config = storage::get_config(env)?;
    let locked = storage::get_balances(env).locked();
    let (funder_amt, recip_amt) = math::split_amount(locked, funder_bps, recipient_bps)?;

    if funder_amt > 0 {
        token::transfer_to(env, &config.funder, funder_amt)?;
        token::credit_refunded(env, funder_amt)?;
    }
    if recip_amt > 0 {
        token::transfer_to(env, &config.recipient, recip_amt)?;
        token::credit_released(env, recip_amt)?;
    }

    dispute.funder_bps = funder_bps;
    dispute.recip_bps = recipient_bps;
    dispute.resolved = true;
    storage::set_dispute(env, &dispute);
    storage::set_state(env, &EscrowState::Completed);

    events::emit_dispute_settled(
        env,
        config.arbitrator,
        funder_bps,
        recipient_bps,
        funder_amt,
        recip_amt,
    );
    Ok(())
}

pub fn default_set(env: &Env, arbitrator: Address) -> ArbitratorSet {
    let mut members = Vec::new(env);
    members.push_back(arbitrator);
    ArbitratorSet {
        members,
        threshold: 1,
    }
}
