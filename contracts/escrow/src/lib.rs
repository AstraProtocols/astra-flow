#![no_std]

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Vec};

mod errors;
mod events;
mod storage;
mod token;

pub use errors::Error;
pub use events::{
    DisputeRaised, DisputeSettled, EmergencyPaused, EscrowInitialized, MilestoneApproved,
    MilestoneCreated, MilestoneSubmitted,
};
pub use storage::{
    BalanceBook, DataKey, DisputeRecord, EscrowConfig, EscrowState, Milestone, MilestoneStatus,
};

#[cfg(test)]
mod test;

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
            return Err(Error::ZeroAmountAllocated);
        }

        let mut total: i128 = 0;
        let mut ids = Vec::<u32>::new(&env);
        let mut expected_id: u32 = 1;

        for milestone in milestones.iter() {
            if milestone.milestone_id != expected_id {
                return Err(Error::InvalidMilestoneSequence);
            }
            expected_id = expected_id
                .checked_add(1)
                .ok_or(Error::InvalidMilestoneSequence)?;

            Error::from_amount(milestone.payout_amount)?;
            ids.push_back(milestone.milestone_id);
            total = total
                .checked_add(milestone.payout_amount)
                .ok_or(Error::BadAmount)?;

            storage::set_milestone(
                &env,
                &Milestone {
                    milestone_id: milestone.milestone_id,
                    payout_amount: milestone.payout_amount,
                    description_hash: milestone.description_hash.clone(),
                    is_approved: false,
                    completed_at: 0,
                    status: MilestoneStatus::Pending,
                    submitted_at: 0,
                },
            );
            events::emit_milestone_created(
                &env,
                milestone.milestone_id,
                milestone.payout_amount,
                milestone.description_hash,
            );
        }

        let config = EscrowConfig {
            funder: funder.clone(),
            recipient: recipient.clone(),
            arbitrator: arbitrator.clone(),
            asset: token.clone(),
            total_amount: total,
            release_threshold: ids.len() as u32,
            lock_secs: storage::DEFAULT_LOCK_WINDOW,
        };

        storage::set_admin(&env, &funder);
        storage::set_config(&env, &config);
        storage::set_state(&env, &EscrowState::Pending);
        storage::set_balances(&env, &BalanceBook::empty());
        storage::set_milestone_ids(&env, &ids);
        storage::set_approved_count(&env, 0);

        events::emit_initialized(
            &env,
            funder,
            recipient,
            arbitrator,
            token,
            total,
            ids.len() as u32,
        );

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
            return Err(Error::MilestoneAlreadyCompleted);
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

        events::emit_milestone_submitted(
            &env,
            milestone_id,
            config.recipient,
            proof_hash,
            submitted_at,
        );

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

        let now = env.ledger().timestamp();
        storage::set_dispute(
            &env,
            &DisputeRecord {
                raised_by: config.funder.clone(),
                raised_at: now,
                funder_bps: 0,
                recip_bps: 0,
                resolved: false,
            },
        );
        Self::mark_open_milestones_disputed(&env)?;
        storage::set_state(&env, &EscrowState::Disputed);

        events::emit_dispute_raised(&env, config.funder, now);

        Ok(())
    }

    /// Arbitrator splits remaining locked tokens between funder and recipient.
    /// `funder_bps` and `recipient_bps` are basis points and must sum to 10_000.
    pub fn resolve_dispute(env: Env, funder_bps: u32, recipient_bps: u32) -> Result<(), Error> {
        let config = storage::get_config(&env)?;
        config.arbitrator.require_auth();

        if storage::get_state(&env)? != EscrowState::Disputed {
            return Err(Error::BadState);
        }
        if funder_bps
            .checked_add(recipient_bps)
            .ok_or(Error::BadSplit)?
            != 10_000
        {
            return Err(Error::BadSplit);
        }

        let mut dispute = storage::get_dispute(&env)?;
        if dispute.resolved {
            return Err(Error::AlreadyPaid);
        }

        let locked = storage::get_balances(&env).locked();
        let funder_amt = locked
            .checked_mul(i128::from(funder_bps))
            .ok_or(Error::BadAmount)?
            / 10_000;
        let recip_amt = locked - funder_amt;

        if funder_amt > 0 {
            token::transfer_to(&env, &config.funder, funder_amt)?;
            token::credit_refunded(&env, funder_amt)?;
        }
        if recip_amt > 0 {
            token::transfer_to(&env, &config.recipient, recip_amt)?;
            token::credit_released(&env, recip_amt)?;
        }

        dispute.funder_bps = funder_bps;
        dispute.recip_bps = recipient_bps;
        dispute.resolved = true;
        storage::set_dispute(&env, &dispute);
        storage::set_state(&env, &EscrowState::Completed);

        events::emit_dispute_settled(
            &env,
            config.arbitrator,
            funder_bps,
            recipient_bps,
            funder_amt,
            recip_amt,
        );

        Ok(())
    }

    /// Funder recovers remaining locked tokens after the proof lock window elapses.
    pub fn claim_timeout_refund(env: Env) -> Result<(), Error> {
        let config = storage::get_config(&env)?;
        config.funder.require_auth();

        let state = storage::get_state(&env)?;
        if state != EscrowState::Active {
            return Err(Error::BadState);
        }

        let now = env.ledger().timestamp();
        let unlock_at = storage::get_lock_until(&env);
        if now < unlock_at {
            return Err(Error::DeadlineNotExceeded);
        }

        let refund = storage::get_balances(&env).locked();
        if refund <= 0 {
            return Err(Error::NoDeposit);
        }

        token::transfer_to(&env, &config.funder, refund)?;
        token::credit_refunded(&env, refund)?;
        storage::set_state(&env, &EscrowState::Cancelled);

        events::emit_timeout_refunded(&env, config.funder, refund, now);

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

    pub fn get_dispute(env: Env) -> Result<DisputeRecord, Error> {
        storage::get_dispute(&env)
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
            return Err(Error::MilestoneAlreadyCompleted);
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

        events::emit_milestone_approved(
            env,
            milestone_id,
            config.recipient,
            milestone.payout_amount,
        );

        Ok(())
    }

    fn mark_open_milestones_disputed(env: &Env) -> Result<(), Error> {
        let ids = storage::get_milestone_ids(env);
        for id in ids.iter() {
            let mut milestone = storage::get_milestone(env, id)?;
            if milestone.status != MilestoneStatus::Released {
                milestone.status = MilestoneStatus::Disputed;
                storage::set_milestone(env, &milestone);
            }
        }
        Ok(())
    }

    fn validate_roles(
        funder: &Address,
        recipient: &Address,
        arbitrator: &Address,
        token: &Address,
    ) -> Result<(), Error> {
        if funder == arbitrator || recipient == arbitrator {
            return Err(Error::ArbitratorCollision);
        }
        if funder == recipient {
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
            EscrowState::Disputed => Err(Error::DisputeLockActive),
            _ => Err(Error::from_mutability(false)),
        }
    }
}
