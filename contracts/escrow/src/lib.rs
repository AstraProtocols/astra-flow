#![no_std]

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Vec};

mod access;
mod dispute;
mod errors;
mod events;
mod math;
mod milestone;
mod storage;
mod token;
mod ttl;
mod vesting;

pub use access::{
    Role, require_actor, require_all, require_any_role, require_dual, require_emergency_admin,
    require_quorum, require_releaser,
};
pub use errors::Error;
pub use events::{
    DisputeRaised, DisputeSettled, EmergencyPaused, EscrowInitialized, MilestoneApproved,
    MilestoneCreated, MilestoneSubmitted,
};
pub use math::{
    apply_bps, apply_penalty, floor_div, protocol_fee, ratio_share, split_amount, vested_amount,
    BPS_SCALE, BPS_SCALE_I128,
};
pub use storage::{
    Amendment, BalanceBook, DataKey, DisputeRecord, EscrowConfig, EscrowState, EvidenceEntry,
    Milestone, MilestoneStatus,
};
pub use ttl::{
    extend_all_persistent, extend_instance, extend_on_initialize, extend_on_proof_submitted,
    extend_persistent,
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
                    vesting_secs: milestone.vesting_secs,
                    streamed: 0,
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
        storage::set_paused(&env, false);

        events::emit_initialized(
            &env,
            funder,
            recipient,
            arbitrator,
            token,
            total,
            ids.len() as u32,
        );
        ttl::extend_on_initialize(&env);

        Ok(())
    }

    /// Pull the funder's pre-approved token allowance into the contract balance.
    pub fn deposit_funds(env: Env) -> Result<(), Error> {
        Self::assert_not_paused(&env)?;
        token::deposit_funds(&env)
    }

    /// Recipient submits an off-chain proof hash for a pending milestone.
    pub fn submit_milestone_proof(
        env: Env,
        milestone_id: u32,
        proof_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let config = storage::get_config(&env)?;
        access::require_recipient(&env)?;
        Self::assert_not_paused(&env)?;
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
        ttl::extend_on_proof_submitted(&env, milestone_id);

        Ok(())
    }

    /// Funder or arbitrator signs off on a milestone and releases its payout.
    pub fn approve_milestone(env: Env, milestone_id: u32) -> Result<(), Error> {
        Self::assert_not_paused(&env)?;
        storage::enter_guard(&env)?;
        let result = Self::approve_milestone_inner(&env, milestone_id);
        storage::exit_guard(&env);
        result
    }

    /// Freeze unreleased milestone balances until the arbitrator resolves.
    pub fn raise_dispute(env: Env) -> Result<(), Error> {
        Self::assert_not_paused(&env)?;
        let config = storage::get_config(&env)?;
        access::require_funder(&env)?;

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
        Self::assert_not_paused(&env)?;
        let config = storage::get_config(&env)?;
        access::require_arbitrator(&env)?;

        if storage::get_state(&env)? != EscrowState::Disputed {
            return Err(Error::BadState);
        }
        math::require_full_bps(funder_bps, recipient_bps)?;

        let mut dispute = storage::get_dispute(&env)?;
        if dispute.resolved {
            return Err(Error::AlreadyPaid);
        }

        let locked = storage::get_balances(&env).locked();
        let (funder_amt, recip_amt) = math::split_amount(locked, funder_bps, recipient_bps)?;

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
        Self::assert_not_paused(&env)?;
        let config = storage::get_config(&env)?;
        access::require_funder(&env)?;

        let state = storage::get_state(&env)?;
        if state != EscrowState::Active {
            return Err(Error::BadState);
        }

        let now = env.ledger().timestamp();
        let unlock_at = storage::get_lock_until(&env);
        if now < unlock_at {
            return Err(Error::DeadlineNotExceeded);
        }

        let locked = storage::get_balances(&env).locked();
        let reserved = vesting::unstreamed_obligation(&env)?;
        let refund = locked.checked_sub(reserved).ok_or(Error::BadAmount)?;
        if refund <= 0 {
            return Err(Error::NoDeposit);
        }

        token::transfer_to(&env, &config.funder, refund)?;
        token::credit_refunded(&env, refund)?;
        storage::set_state(&env, &EscrowState::Cancelled);

        events::emit_timeout_refunded(&env, config.funder, refund, now);

        Ok(())
    }

    /// Governance circuit-breaker. Freezes deposits, proofs, releases, disputes,
    /// and refunds until `emergency_unpause`. Read getters remain available.
    pub fn emergency_pause(env: Env) -> Result<(), Error> {
        let admin = access::require_emergency_admin(&env)?;
        if storage::is_paused(&env) {
            return Err(Error::Paused);
        }
        storage::set_paused(&env, true);
        events::emit_emergency_paused(&env, admin, true, env.ledger().timestamp());
        ttl::extend_instance(&env);
        Ok(())
    }

    /// Restore mutating entrypoints after an emergency freeze.
    pub fn emergency_unpause(env: Env) -> Result<(), Error> {
        let admin = access::require_emergency_admin(&env)?;
        if !storage::is_paused(&env) {
            return Err(Error::BadState);
        }
        storage::set_paused(&env, false);
        events::emit_emergency_paused(&env, admin, false, env.ledger().timestamp());
        ttl::extend_instance(&env);
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    /// Funder or recipient proposes a scope/order change. Counterparty must approve.
    pub fn request_milestone_amendment(
        env: Env,
        actor: Address,
        milestone_id: u32,
        payout_amount: i128,
        description_hash: BytesN<32>,
        new_position: u32,
    ) -> Result<(), Error> {
        milestone::request_milestone_amendment(
            &env,
            actor,
            milestone_id,
            payout_amount,
            description_hash,
            new_position,
        )
    }

    /// Mutual dual-party approval applies the pending milestone amendment.
    pub fn approve_amendment(env: Env) -> Result<Amendment, Error> {
        milestone::approve_amendment(&env)
    }

    pub fn get_amendment(env: Env) -> Result<Amendment, Error> {
        storage::get_amendment(&env)
    }

    /// Funder or recipient appends a content hash to the open dispute docket.
    pub fn append_dispute_evidence(
        env: Env,
        actor: Address,
        content_hash: BytesN<32>,
    ) -> Result<u32, Error> {
        dispute::append_dispute_evidence(&env, actor, content_hash)
    }

    pub fn get_evidence(env: Env) -> soroban_sdk::Vec<EvidenceEntry> {
        storage::get_evidence(&env)
    }

    /// Recipient withdraws the linear vested delta for an approved streaming milestone.
    pub fn stream_milestone_payout(env: Env, milestone_id: u32) -> Result<i128, Error> {
        vesting::stream_milestone_payout(&env, milestone_id)
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
        access::require_releaser(env)?;

        let book = storage::get_balances(env);
        if book.deposited == 0 {
            return Err(Error::NoDeposit);
        }

        let mut milestone = storage::get_milestone(env, milestone_id)?;
        if milestone.is_approved || milestone.status == MilestoneStatus::Released {
            return Err(Error::MilestoneAlreadyCompleted);
        }

        milestone.is_approved = true;
        milestone.completed_at = env.ledger().timestamp();
        if vesting::is_streaming(milestone.vesting_secs) {
            milestone.status = MilestoneStatus::UnderReview;
            milestone.streamed = 0;
            storage::set_milestone(env, &milestone);
        } else {
            token::transfer_to(env, &config.recipient, milestone.payout_amount)?;
            milestone.status = MilestoneStatus::Released;
            milestone.streamed = milestone.payout_amount;
            storage::set_milestone(env, &milestone);
            token::credit_released(env, milestone.payout_amount)?;
        }

        let approved_count = storage::increment_approved(env);
        if approved_count >= config.release_threshold {
            storage::set_state(env, &EscrowState::Completed);
        } else if storage::get_state(env)? == EscrowState::Disputed {
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

    fn assert_not_paused(env: &Env) -> Result<(), Error> {
        if storage::is_paused(env) {
            Err(Error::Paused)
        } else {
            Ok(())
        }
    }

    fn assert_mutable(env: &Env) -> Result<(), Error> {
        match storage::get_state(env)? {
            EscrowState::Active => Ok(()),
            EscrowState::Disputed => Err(Error::DisputeLockActive),
            _ => Err(Error::from_mutability(false)),
        }
    }
}
