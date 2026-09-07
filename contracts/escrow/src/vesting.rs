use soroban_sdk::Env;

use crate::access;
use crate::math;
use crate::storage::{self, EscrowState, MilestoneStatus};
use crate::token;
use crate::Error;

/// Pull the newly vested portion of an approved milestone to the recipient.
/// Unlock is linear between `completed_at` and `completed_at + vesting_secs`,
/// floored per `math::vested_amount` so streamed totals never exceed payout.
pub fn stream_milestone_payout(env: &Env, milestone_id: u32) -> Result<i128, Error> {
    if storage::is_paused(env) {
        return Err(Error::Paused);
    }
    access::require_recipient(env)?;

    let state = storage::get_state(env)?;
    if state == EscrowState::Disputed {
        return Err(Error::DisputeLockActive);
    }
    if state != EscrowState::Active && state != EscrowState::Completed {
        return Err(Error::BadState);
    }

    let config = storage::get_config(env)?;
    let mut milestone = storage::get_milestone(env, milestone_id)?;
    if !milestone.is_approved {
        return Err(Error::VestingIncomplete);
    }
    if milestone.vesting_secs == 0 {
        return Err(Error::BadState);
    }
    if milestone.streamed >= milestone.payout_amount {
        return Err(Error::MilestoneAlreadyCompleted);
    }

    let start = milestone.completed_at;
    let end = start
        .checked_add(milestone.vesting_secs)
        .ok_or(Error::BadAmount)?;
    let vested = math::vested_amount(
        milestone.payout_amount,
        start,
        end,
        env.ledger().timestamp(),
    )?;
    let unpaid = vested
        .checked_sub(milestone.streamed)
        .ok_or(Error::BadAmount)?;
    if unpaid <= 0 {
        return Err(Error::VestingIncomplete);
    }

    token::transfer_to(env, &config.recipient, unpaid)?;
    token::credit_released(env, unpaid)?;
    milestone.streamed = milestone
        .streamed
        .checked_add(unpaid)
        .ok_or(Error::BadAmount)?;
    if milestone.streamed >= milestone.payout_amount {
        milestone.status = MilestoneStatus::Released;
    }
    storage::set_milestone(env, &milestone);
    Ok(unpaid)
}

/// True when approval should stream over time instead of paying a lump sum.
pub fn is_streaming(vesting_secs: u64) -> bool {
    vesting_secs > 0
}

/// Tokens already promised to recipients via approval but not yet streamed.
pub fn unstreamed_obligation(env: &Env) -> Result<i128, Error> {
    let mut owed: i128 = 0;
    let ids = storage::get_milestone_ids(env);
    for id in ids.iter() {
        let milestone = storage::get_milestone(env, id)?;
        if milestone.is_approved {
            let rest = milestone
                .payout_amount
                .checked_sub(milestone.streamed)
                .ok_or(Error::BadAmount)?;
            owed = owed.checked_add(rest).ok_or(Error::BadAmount)?;
        }
    }
    Ok(owed)
}
