use soroban_sdk::{Address, BytesN, Env, Vec};

use crate::access;
use crate::storage::{self, Amendment, EscrowState, MilestoneStatus};
use crate::Error;

fn assert_party(env: &Env, actor: &Address) -> Result<bool, Error> {
    let cfg = storage::get_config(env)?;
    if actor == &cfg.funder {
        actor.require_auth();
        Ok(true)
    } else if actor == &cfg.recipient {
        actor.require_auth();
        Ok(false)
    } else {
        Err(Error::NotAuthorized)
    }
}

/// Propose a scope change (payout, description hash, and/or display order).
/// The counterparty must call `approve_amendment` before it takes effect.
pub fn request_milestone_amendment(
    env: &Env,
    actor: Address,
    milestone_id: u32,
    payout_amount: i128,
    description_hash: BytesN<32>,
    new_position: u32,
) -> Result<(), Error> {
    if storage::is_paused(env) {
        return Err(Error::Paused);
    }
    let is_funder = assert_party(env, &actor)?;
    let state = storage::get_state(env)?;
    if state == EscrowState::Disputed {
        return Err(Error::DisputeLockActive);
    }
    if state != EscrowState::Pending && state != EscrowState::Active {
        return Err(Error::BadState);
    }

    let milestone = storage::get_milestone(env, milestone_id)?;
    if milestone.is_approved || milestone.status == MilestoneStatus::Released {
        return Err(Error::MilestoneAlreadyCompleted);
    }
    Error::from_amount(payout_amount)?;

    let ids = storage::get_milestone_ids(env);
    if new_position >= ids.len() {
        return Err(Error::InvalidMilestoneSequence);
    }

    if state == EscrowState::Active && payout_amount != milestone.payout_amount {
        // Funded escrows only permit scope/order edits; amounts stay frozen.
        return Err(Error::BadAmount);
    }

    if let Ok(existing) = storage::get_amendment(env) {
        if existing.funder_approved && existing.recipient_approved {
            return Err(Error::AmendmentPending);
        }
    }

    storage::set_amendment(
        env,
        &Amendment {
            milestone_id,
            payout_amount,
            description_hash,
            new_position,
            proposed_by: actor,
            funder_approved: is_funder,
            recipient_approved: !is_funder,
        },
    );
    Ok(())
}

/// Counterparty signs the pending amendment. When both sides have approved,
/// the milestone record and ordering are rewritten atomically.
pub fn approve_amendment(env: &Env) -> Result<Amendment, Error> {
    if storage::is_paused(env) {
        return Err(Error::Paused);
    }
    let cfg = storage::get_config(env)?;
    let mut proposal = storage::get_amendment(env)?;
    if proposal.funder_approved && proposal.recipient_approved {
        return Err(Error::AlreadyPaid);
    }

    access::require_dual(&cfg.funder, &cfg.recipient)?;

    proposal.funder_approved = true;
    proposal.recipient_approved = true;
    apply_amendment(env, &proposal)?;
    storage::clear_amendment(env);
    Ok(proposal)
}

fn apply_amendment(env: &Env, proposal: &Amendment) -> Result<(), Error> {
    let mut milestone = storage::get_milestone(env, proposal.milestone_id)?;
    if milestone.is_approved || milestone.status == MilestoneStatus::Released {
        return Err(Error::MilestoneAlreadyCompleted);
    }

    let state = storage::get_state(env)?;
    if state == EscrowState::Pending && proposal.payout_amount != milestone.payout_amount {
        let mut config = storage::get_config(env)?;
        let new_total = config
            .total_amount
            .checked_sub(milestone.payout_amount)
            .and_then(|rest| rest.checked_add(proposal.payout_amount))
            .ok_or(Error::BadAmount)?;
        Error::from_amount(new_total)?;
        config.total_amount = new_total;
        storage::set_config(env, &config);
        milestone.payout_amount = proposal.payout_amount;
    }

    milestone.description_hash = proposal.description_hash.clone();
    storage::set_milestone(env, &milestone);
    reorder_milestone(env, proposal.milestone_id, proposal.new_position)?;
    Ok(())
}

fn reorder_milestone(env: &Env, milestone_id: u32, new_position: u32) -> Result<(), Error> {
    let ids = storage::get_milestone_ids(env);
    let mut ordered = Vec::<u32>::new(env);
    let mut found = false;
    for id in ids.iter() {
        if id == milestone_id {
            found = true;
            continue;
        }
        ordered.push_back(id);
    }
    if !found {
        return Err(Error::NotFound);
    }
    if new_position > ordered.len() {
        return Err(Error::InvalidMilestoneSequence);
    }

    let mut result = Vec::<u32>::new(env);
    for (index, id) in ordered.iter().enumerate() {
        if index as u32 == new_position {
            result.push_back(milestone_id);
        }
        result.push_back(id);
    }
    if new_position == ordered.len() {
        result.push_back(milestone_id);
    }
    storage::set_milestone_ids(env, &result);
    Ok(())
}
