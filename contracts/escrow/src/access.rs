use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::storage::{self, EscrowConfig};
use crate::Error;

/// Named identities that may authorize escrow mutations.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Role {
    Funder = 0,
    Recipient = 1,
    Arbitrator = 2,
    EmergencyAdmin = 3,
}

pub fn config(env: &Env) -> Result<EscrowConfig, Error> {
    storage::get_config(env)
}

pub fn address_for(env: &Env, role: Role) -> Result<Address, Error> {
    let cfg = config(env)?;
    Ok(match role {
        Role::Funder => cfg.funder,
        Role::Recipient => cfg.recipient,
        Role::Arbitrator => cfg.arbitrator,
        Role::EmergencyAdmin => storage::get_admin(env)?,
    })
}

/// Consume a Soroban auth for the address bound to `role`.
pub fn require_role(env: &Env, role: Role) -> Result<Address, Error> {
    let who = address_for(env, role)?;
    who.require_auth();
    Ok(who)
}

pub fn require_funder(env: &Env) -> Result<Address, Error> {
    require_role(env, Role::Funder)
}

pub fn require_recipient(env: &Env) -> Result<Address, Error> {
    require_role(env, Role::Recipient)
}

pub fn require_arbitrator(env: &Env) -> Result<Address, Error> {
    require_role(env, Role::Arbitrator)
}

pub fn require_emergency_admin(env: &Env) -> Result<Address, Error> {
    require_role(env, Role::EmergencyAdmin)
}

/// Confirm `actor` is the stored identity for `role` and consume its auth.
pub fn require_actor(env: &Env, actor: &Address, role: Role) -> Result<(), Error> {
    let expected = address_for(env, role)?;
    if actor != &expected {
        return Err(Error::NotAuthorized);
    }
    actor.require_auth();
    Ok(())
}

/// Dual-party assertion used by amendment and settlement flows.
pub fn require_dual(left: &Address, right: &Address) -> Result<(), Error> {
    if left == right {
        return Err(Error::BadRoles);
    }
    left.require_auth();
    right.require_auth();
    Ok(())
}

/// Every listed signer must attach a signature (N-of-N).
pub fn require_all(signers: &Vec<Address>) -> Result<(), Error> {
    if signers.is_empty() {
        return Err(Error::NotAuthorized);
    }
    let mut prev: Option<Address> = None;
    for signer in signers.iter() {
        if let Some(ref last) = prev {
            if last == &signer {
                return Err(Error::BadRoles);
            }
        }
        signer.require_auth();
        prev = Some(signer.clone());
    }
    Ok(())
}

/// M-of-N: the first `threshold` unique signers in `signers` must authorize.
pub fn require_quorum(signers: &Vec<Address>, threshold: u32) -> Result<(), Error> {
    if threshold == 0 || (signers.len() as u32) < threshold {
        return Err(Error::QuorumNotMet);
    }
    let mut accepted: u32 = 0;
    let mut seen: Vec<Address> = Vec::new(signers.env());
    for signer in signers.iter() {
        let mut duplicate = false;
        for existing in seen.iter() {
            if existing == signer {
                duplicate = true;
                break;
            }
        }
        if duplicate {
            continue;
        }
        signer.require_auth();
        seen.push_back(signer.clone());
        accepted = accepted.saturating_add(1);
        if accepted >= threshold {
            return Ok(());
        }
    }
    Err(Error::QuorumNotMet)
}

/// Authorize `actor` if it matches any of the supplied roles.
pub fn require_any_role(env: &Env, actor: &Address, roles: &Vec<Role>) -> Result<Role, Error> {
    if roles.is_empty() {
        return Err(Error::NotAuthorized);
    }
    actor.require_auth();
    for role in roles.iter() {
        if address_for(env, role)? == *actor {
            return Ok(role);
        }
    }
    Err(Error::NotAuthorized)
}

/// Funder (live escrow) or arbitrator (disputed escrow) must sign approvals.
pub fn require_releaser(env: &Env) -> Result<Role, Error> {
    let state = storage::get_state(env)?;
    match state {
        crate::EscrowState::Active => {
            require_funder(env)?;
            Ok(Role::Funder)
        }
        crate::EscrowState::Disputed => {
            require_arbitrator(env)?;
            Ok(Role::Arbitrator)
        }
        _ => Err(Error::BadState),
    }
}
