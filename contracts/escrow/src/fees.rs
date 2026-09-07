use soroban_sdk::{Address, Env};

use crate::access;
use crate::math;
use crate::storage::{self, EscrowState};
use crate::token;
use crate::Error;

/// Bind a treasury address and protocol fee in basis points. Governance-only,
/// and only before the escrow is funded so counterparties can inspect terms.
pub fn configure_protocol_fee(env: &Env, treasury: Address, fee_bps: u32) -> Result<(), Error> {
    if storage::is_paused(env) {
        return Err(Error::Paused);
    }
    access::require_emergency_admin(env)?;
    if storage::get_state(env)? != EscrowState::Pending {
        return Err(Error::BadState);
    }
    if fee_bps > math::BPS_SCALE {
        return Err(Error::FeeOverflow);
    }
    let cfg = storage::get_config(env)?;
    if treasury == cfg.recipient {
        return Err(Error::BadRoles);
    }
    storage::set_treasury(env, &treasury);
    storage::set_fee_bps(env, fee_bps);
    Ok(())
}

/// Route `fee` to the treasury and return the recipient net for `gross`.
/// A zero fee or missing treasury is a no-op so existing escrows stay whole.
pub fn disbursement_split(env: &Env, gross: i128) -> Result<(i128, i128), Error> {
    Error::from_amount(gross)?;
    let bps = storage::get_fee_bps(env);
    if bps == 0 {
        return Ok((0, gross));
    }
    math::protocol_fee(gross, bps)
}

/// Transfer protocol fee then recipient net. Returns net paid to the recipient.
pub fn pay_with_fee(env: &Env, recipient: &Address, gross: i128) -> Result<i128, Error> {
    let (fee, net) = disbursement_split(env, gross)?;
    if fee > 0 {
        let treasury = storage::get_treasury(env)?;
        token::transfer_to(env, &treasury, fee)?;
        token::credit_released(env, fee)?;
    }
    if net > 0 {
        token::transfer_to(env, recipient, net)?;
        token::credit_released(env, net)?;
    }
    Ok(net)
}
