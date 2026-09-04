#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, symbol_short, token, Address, BytesN, Env, Vec,
};

mod storage;

pub use storage::{BalanceBook, DataKey, EscrowConfig, EscrowState, Milestone};

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
        if milestones.is_empty() {
            return Err(Error::BadAmount);
        }

        let mut total: i128 = 0;
        let mut ids = Vec::<u32>::new(&env);

        for milestone in milestones.iter() {
            if milestone.payout_amount <= 0 {
                return Err(Error::BadAmount);
            }
            for existing in ids.iter() {
                if existing == milestone.milestone_id {
                    return Err(Error::DupId);
                }
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
                },
            );
        }

        let config = EscrowConfig {
            funder: funder.clone(),
            recipient,
            arbitrator,
            asset: token,
            total_amount: total,
            release_threshold: ids.len() as u32,
        };

        storage::set_admin(&env, &funder);
        storage::set_config(&env, &config);
        storage::set_state(&env, &EscrowState::Pending);
        storage::set_balances(&env, &BalanceBook::empty());
        storage::set_milestone_ids(&env, &ids);
        storage::set_approved_count(&env, 0);

        env.events()
            .publish((symbol_short!("init"), funder.clone()), total);

        Ok(())
    }

    /// Pull the funder's pre-approved token allowance into the contract balance.
    pub fn deposit_funds(env: Env) -> Result<(), Error> {
        let config = storage::get_config(&env)?;
        config.funder.require_auth();

        let state = storage::get_state(&env)?;
        if state != EscrowState::Pending {
            return Err(Error::BadState);
        }

        let mut book = storage::get_balances(&env);
        if book.deposited > 0 {
            return Err(Error::AlreadyPaid);
        }

        let token_client = token::Client::new(&env, &config.asset);
        token_client.transfer_from(
            &env.current_contract_address(),
            &config.funder,
            &env.current_contract_address(),
            &config.total_amount,
        );

        book.deposited = config.total_amount;
        storage::set_balances(&env, &book);
        storage::set_state(&env, &EscrowState::Active);

        env.events().publish(
            (symbol_short!("deposit"), config.funder.clone()),
            config.total_amount,
        );

        Ok(())
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

        let milestone = storage::get_milestone(&env, milestone_id)?;
        if milestone.is_approved {
            return Err(Error::AlreadyPaid);
        }

        storage::set_proof(&env, milestone_id, &proof_hash);

        env.events()
            .publish((symbol_short!("proof"), milestone_id), proof_hash);

        Ok(())
    }

    /// Funder or arbitrator signs off on a milestone and releases its payout.
    /// During a dispute, only the arbitrator may unlock funds.
    pub fn approve_milestone(env: Env, milestone_id: u32) -> Result<(), Error> {
        let config = storage::get_config(&env)?;
        let state = storage::get_state(&env)?;

        match state {
            EscrowState::Active => {
                config.funder.require_auth();
            }
            EscrowState::Disputed => {
                config.arbitrator.require_auth();
            }
            _ => return Err(Error::BadState),
        }

        let mut book = storage::get_balances(&env);
        if book.deposited == 0 {
            return Err(Error::NoDeposit);
        }

        let mut milestone = storage::get_milestone(&env, milestone_id)?;
        if milestone.is_approved {
            return Err(Error::AlreadyPaid);
        }

        let token_client = token::Client::new(&env, &config.asset);
        token_client.transfer(
            &env.current_contract_address(),
            &config.recipient,
            &milestone.payout_amount,
        );

        milestone.is_approved = true;
        milestone.completed_at = env.ledger().timestamp();
        storage::set_milestone(&env, &milestone);

        book.released = book
            .released
            .checked_add(milestone.payout_amount)
            .ok_or(Error::BadAmount)?;
        storage::set_balances(&env, &book);

        let approved_count = storage::increment_approved(&env);
        if approved_count >= config.release_threshold {
            storage::set_state(&env, &EscrowState::Completed);
        } else if state == EscrowState::Disputed {
            storage::set_state(&env, &EscrowState::Active);
        }

        env.events().publish(
            (symbol_short!("release"), milestone_id),
            milestone.payout_amount,
        );

        Ok(())
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
    fn assert_mutable(env: &Env) -> Result<(), Error> {
        match storage::get_state(env)? {
            EscrowState::Active => Ok(()),
            EscrowState::Disputed => Err(Error::Locked),
            _ => Err(Error::BadState),
        }
    }
}
