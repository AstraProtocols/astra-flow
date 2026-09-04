#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, symbol_short, Address, BytesN, Env, Vec,
};

mod storage;
mod token;

pub use storage::{BalanceBook, DataKey, EscrowConfig, EscrowState, Milestone, MilestoneStatus};

#[cfg(test)]
mod test;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInit = 1,
    NotInit = 2,
    Unauthorized = 3,
    BadState = 4,
    NotFound = 5,
    AlreadyPaid = 6,
    NoDeposit = 7,
    Locked = 8,
    BadAmount = 9,
    DupId = 10,
    BadToken = 11,
    BadRoles = 12,
    BadSequence = 13,
    AlreadySubmitted = 14,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowInitialized {
    #[topic]
    pub funder: Address,
    pub recipient: Address,
    pub arbitrator: Address,
    pub token: Address,
    pub total: i128,
    pub count: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProofSubmitted {
    #[topic]
    pub milestone: u32,
    pub recipient: Address,
    pub proof: BytesN<32>,
    pub at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneReleased {
    #[topic]
    pub milestone: u32,
    pub recipient: Address,
    pub amount: i128,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Configure parties, asset, and milestone schedule. Leaves the escrow in `Pending`.
    pub fn initialize(
        env: Env,
        funder: Address,
        recipient: Address,
        arbitrator: Address,
        token: Address,
        milestones: Vec<Milestone>,
    ) -> Result<(), Error> {
        funder.require_auth();

        if storage::is_initialized(&env) {
            return Err(Error::AlreadyInit);
        }

        Self::validate_roles(&funder, &recipient, &arbitrator, &token)?;
        token::assert_sep41_token(&env, &token)?;

        if milestones.is_empty() {
            return Err(Error::BadAmount);
        }

        let mut total: i128 = 0;
        let mut ids = Vec::<u32>::new(&env);
        let mut expected_id: u32 = 1;

        for milestone in milestones.iter() {
            if milestone.milestone_id != expected_id {
                return Err(Error::BadSequence);
            }
            expected_id = expected_id.checked_add(1).ok_or(Error::BadSequence)?;

            if milestone.payout_amount <= 0 {
                return Err(Error::BadAmount);
            }
            ids.push_back(milestone.milestone_id);
            total = total
                .checked_add(milestone.payout_amount)
                .ok_or(Error::BadAmount)?;

            storage::set_milestone(
                &env,
                &Milestone {
                    milestone_id: milestone.milestone_id,
                    payout_amount: milestone.payout_amount,
                    description_hash: milestone.description_hash,
                    is_approved: false,
                    completed_at: 0,
                    status: MilestoneStatus::Pending,
                    submitted_at: 0,
                },
            );
        }

        let config = EscrowConfig {
            funder: funder.clone(),
            recipient: recipient.clone(),
            arbitrator: arbitrator.clone(),
            asset: token.clone(),
            total_amount: total,
            release_threshold: ids.len() as u32,
        };

        storage::set_admin(&env, &funder);
        storage::set_config(&env, &config);
        storage::set_state(&env, &EscrowState::Pending);
        storage::set_balances(&env, &BalanceBook::empty());
        storage::set_milestone_ids(&env, &ids);
        storage::set_approved_count(&env, 0);

        EscrowInitialized {
            funder: funder.clone(),
            recipient,
            arbitrator,
            token,
            total,
            count: ids.len() as u32,
        }
        .publish(&env);

        Ok(())
    }

    /// Pull the funder's pre-approved token allowance into the contract balance.
    pub fn deposit_funds(env: Env) -> Result<(), Error> {
        token::deposit_funds(&env)
    }

    /// Recipient submits an off-chain proof hash for a pending milestone.
    pub fn submit_milestone_proof(
        env: Env,
        milestone_id: u32,
        proof_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let config = storage::get_config(&env)?;
        config.recipient.require_auth();
        Self::assert_mutable(&env)?;

        let mut milestone = storage::get_milestone(&env, milestone_id)?;
        if milestone.is_approved || milestone.status == MilestoneStatus::Released {
            return Err(Error::AlreadyPaid);
        }
        if milestone.status == MilestoneStatus::UnderReview {
            return Err(Error::AlreadySubmitted);
        }
        if milestone.status != MilestoneStatus::Pending {
            return Err(Error::BadState);
        }

        let submitted_at = env.ledger().timestamp();
        milestone.status = MilestoneStatus::UnderReview;
        milestone.submitted_at = submitted_at;
        storage::set_milestone(&env, &milestone);
        storage::set_proof(&env, milestone_id, &proof_hash);

        ProofSubmitted {
            milestone: milestone_id,
            recipient: config.recipient,
            proof: proof_hash,
            at: submitted_at,
        }
        .publish(&env);

        Ok(())
    }

    /// Funder or arbitrator signs off on a milestone and releases its payout.
    pub fn approve_milestone(env: Env, milestone_id: u32) -> Result<(), Error> {
        storage::enter_guard(&env)?;
        let result = Self::approve_milestone_inner(&env, milestone_id);
        storage::exit_guard(&env);
        result
    }

    /// Freeze unreleased milestone balances until the arbitrator resolves.
    pub fn raise_dispute(env: Env) -> Result<(), Error> {
        let config = storage::get_config(&env)?;
        config.funder.require_auth();

        let state = storage::get_state(&env)?;
        if state != EscrowState::Active {
            return Err(Error::BadState);
        }

        storage::set_state(&env, &EscrowState::Disputed);

        env.events()
            .publish((symbol_short!("dispute"), config.funder.clone()), true);

        Ok(())
    }

    pub fn get_config(env: Env) -> Result<EscrowConfig, Error> {
        storage::get_config(&env)
    }

    pub fn get_state(env: Env) -> Result<EscrowState, Error> {
        storage::get_state(&env)
    }

    pub fn get_milestone(env: Env, milestone_id: u32) -> Result<Milestone, Error> {
        storage::get_milestone(&env, milestone_id)
    }

    pub fn get_proof(env: Env, milestone_id: u32) -> Result<BytesN<32>, Error> {
        storage::get_proof(&env, milestone_id)
    }

    pub fn get_balances(env: Env) -> Result<BalanceBook, Error> {
        if !storage::is_initialized(&env) {
            return Err(Error::NotInit);
        }
        Ok(storage::get_balances(&env))
    }
}

impl EscrowContract {
    fn approve_milestone_inner(env: &Env, milestone_id: u32) -> Result<(), Error> {
        let config = storage::get_config(env)?;
        let state = storage::get_state(env)?;

        match state {
            EscrowState::Active => {
                // Funder is the primary releaser; arbitrator may also authorize while live.
                config.funder.require_auth();
            }
            EscrowState::Disputed => {
                config.arbitrator.require_auth();
            }
            _ => return Err(Error::BadState),
        }

        let book = storage::get_balances(env);
        if book.deposited == 0 {
            return Err(Error::NoDeposit);
        }

        let mut milestone = storage::get_milestone(env, milestone_id)?;
        if milestone.is_approved || milestone.status == MilestoneStatus::Released {
            return Err(Error::AlreadyPaid);
        }

        token::transfer_to(env, &config.recipient, milestone.payout_amount)?;

        milestone.is_approved = true;
        milestone.status = MilestoneStatus::Released;
        milestone.completed_at = env.ledger().timestamp();
        storage::set_milestone(env, &milestone);
        token::credit_released(env, milestone.payout_amount)?;

        let approved_count = storage::increment_approved(env);
        if approved_count >= config.release_threshold {
            storage::set_state(env, &EscrowState::Completed);
        } else if state == EscrowState::Disputed {
            storage::set_state(env, &EscrowState::Active);
        }

        MilestoneReleased {
            milestone: milestone_id,
            recipient: config.recipient,
            amount: milestone.payout_amount,
        }
        .publish(env);

        Ok(())
    }

    fn validate_roles(
        funder: &Address,
        recipient: &Address,
        arbitrator: &Address,
        token: &Address,
    ) -> Result<(), Error> {
        if funder == recipient || funder == arbitrator || recipient == arbitrator {
            return Err(Error::BadRoles);
        }
        if token == funder || token == recipient || token == arbitrator {
            return Err(Error::BadToken);
        }
        Ok(())
    }

    fn assert_mutable(env: &Env) -> Result<(), Error> {
        match storage::get_state(env)? {
            EscrowState::Active => Ok(()),
            EscrowState::Disputed => Err(Error::Locked),
            _ => Err(Error::BadState),
        }
    }
}
