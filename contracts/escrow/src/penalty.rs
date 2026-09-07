use soroban_sdk::Env;

use crate::access;
use crate::math;
use crate::storage::{self, EscrowState, MilestoneStatus};
use crate::token;
use crate::Error;

/// Configure late-delivery penalty in basis points. Only valid before funding.
pub fn set_late_penalty_bps(env: &Env, bps: u32) -> Result<u32, Error> {
    if storage::is_paused(env) {
        return Err(Error::Paused);
    }
    access::require_funder(env)?;
    if storage::get_state(env)? != EscrowState::Pending {
        return Err(Error::BadState);
    }
    if bps > math::BPS_SCALE {
        return Err(Error::PenaltyOverflow);
    }
    storage::set_penalty_bps(env, bps);
    Ok(bps)
}

/// Slash a late milestone: if proof arrived after `deadline`, deduct configured
/// bps from the remaining payout and return that amount to the funder.
pub fn apply_late_penalty(env: &Env, milestone_id: u32) -> Result<i128, Error> {
    if storage::is_paused(env) {
        return Err(Error::Paused);
    }
    access::require_funder(env)?;

    let state = storage::get_state(env)?;
    if state != EscrowState::Active {
        return Err(Error::BadState);
    }

    let mut milestone = storage::get_milestone(env, milestone_id)?;
    if milestone.late_penalty_applied {
        return Err(Error::AlreadyPaid);
    }
    if milestone.is_approved || milestone.status == MilestoneStatus::Released {
        return Err(Error::MilestoneAlreadyCompleted);
    }
    if milestone.status != MilestoneStatus::UnderReview {
        return Err(Error::BadState);
    }
    if milestone.deadline == 0 {
        return Err(Error::BadState);
    }
    if milestone.submitted_at == 0 || milestone.submitted_at <= milestone.deadline {
        return Err(Error::DeadlineNotExceeded);
    }

    let bps = storage::get_penalty_bps(env);
    let (slash, remaining) = math::apply_penalty(milestone.payout_amount, bps)?;
    if slash == 0 {
        milestone.late_penalty_applied = true;
        storage::set_milestone(env, &milestone);
        return Ok(0);
    }

    let config = storage::get_config(env)?;
    token::transfer_to(env, &config.funder, slash)?;
    token::credit_refunded(env, slash)?;
    milestone.payout_amount = remaining;
    milestone.late_penalty_applied = true;
    storage::set_milestone(env, &milestone);
    Ok(slash)
}
