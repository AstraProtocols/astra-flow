#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
    Vec,
};

mod test;

/// Lifecycle of a single escrow instance.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum EscrowState {
    Pending = 0,
    Active = 1,
    Completed = 2,
    Disputed = 3,
    Cancelled = 4,
}

/// A payable work package inside an escrow.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    pub milestone_id: u32,
    pub payout_amount: i128,
    pub description_hash: BytesN<32>,
    pub is_approved: bool,
    pub completed_at: u64,
}

/// Parties, asset, and release policy for the escrow.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowConfig {
    pub funder: Address,
    pub recipient: Address,
    pub arbitrator: Address,
    pub asset: Address,
    pub total_amount: i128,
    pub release_threshold: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Config,
    State,
    Deposited,
    Milestone(u32),
    Proof(u32),
    MileIds,
    Approved,
}

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

        if env.storage().instance().has(&DataKey::Config) {
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

            let stored = Milestone {
                milestone_id: milestone.milestone_id,
                payout_amount: milestone.payout_amount,
                description_hash: milestone.description_hash,
                is_approved: false,
                completed_at: 0,
            };
            env.storage()
                .persistent()
                .set(&DataKey::Milestone(milestone.milestone_id), &stored);
        }

        let config = EscrowConfig {
            funder: funder.clone(),
            recipient,
            arbitrator,
            asset: token,
            total_amount: total,
            release_threshold: ids.len() as u32,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage()
            .instance()
            .set(&DataKey::State, &EscrowState::Pending);
        env.storage().instance().set(&DataKey::Deposited, &false);
        env.storage().instance().set(&DataKey::MileIds, &ids);
        env.storage().instance().set(&DataKey::Approved, &0u32);
        env.storage().instance().extend_ttl(100_000, 100_000);

        env.events()
            .publish((symbol_short!("init"), funder.clone()), total);

        Ok(())
    }

    /// Pull the funder's pre-approved token allowance into the contract balance.
    pub fn deposit_funds(env: Env) -> Result<(), Error> {
        let config = Self::config(&env)?;
        config.funder.require_auth();

        let state = Self::state(&env)?;
        if state != EscrowState::Pending {
            return Err(Error::BadState);
        }

        let deposited: bool = env
            .storage()
            .instance()
            .get(&DataKey::Deposited)
            .unwrap_or(false);
        if deposited {
            return Err(Error::AlreadyPaid);
        }

        let token_client = token::Client::new(&env, &config.asset);
        token_client.transfer_from(
            &env.current_contract_address(),
            &config.funder,
            &env.current_contract_address(),
            &config.total_amount,
        );

        env.storage().instance().set(&DataKey::Deposited, &true);
        env.storage()
            .instance()
            .set(&DataKey::State, &EscrowState::Active);

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
        let config = Self::config(&env)?;
        config.recipient.require_auth();
        Self::assert_mutable(&env)?;

        let milestone = Self::milestone(&env, milestone_id)?;
        if milestone.is_approved {
            return Err(Error::AlreadyPaid);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Proof(milestone_id), &proof_hash);

        env.events()
            .publish((symbol_short!("proof"), milestone_id), proof_hash);

        Ok(())
    }

    /// Funder or arbitrator signs off on a milestone and releases its payout.
    /// During a dispute, only the arbitrator may unlock funds.
    pub fn approve_milestone(env: Env, milestone_id: u32) -> Result<(), Error> {
        let config = Self::config(&env)?;
        let state = Self::state(&env)?;

        match state {
            EscrowState::Active => {
                // Funder is the designated approver while the escrow is live.
                // The arbitrator is the exclusive signer once a dispute is raised.
                config.funder.require_auth();
            }
            EscrowState::Disputed => {
                config.arbitrator.require_auth();
            }
            _ => return Err(Error::BadState),
        }

        let deposited: bool = env
            .storage()
            .instance()
            .get(&DataKey::Deposited)
            .unwrap_or(false);
        if !deposited {
            return Err(Error::NoDeposit);
        }

        let mut milestone = Self::milestone(&env, milestone_id)?;
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
        env.storage()
            .persistent()
            .set(&DataKey::Milestone(milestone_id), &milestone);

        let approved_count = Self::increment_approved(&env);
        if approved_count >= config.release_threshold {
            env.storage()
                .instance()
                .set(&DataKey::State, &EscrowState::Completed);
        } else if state == EscrowState::Disputed {
            env.storage()
                .instance()
                .set(&DataKey::State, &EscrowState::Active);
        }

        env.events().publish(
            (symbol_short!("release"), milestone_id),
            milestone.payout_amount,
        );

        Ok(())
    }

    /// Freeze unreleased milestone balances until the arbitrator resolves.
    pub fn raise_dispute(env: Env) -> Result<(), Error> {
        let config = Self::config(&env)?;
        config.funder.require_auth();

        let state = Self::state(&env)?;
        if state != EscrowState::Active {
            return Err(Error::BadState);
        }

        env.storage()
            .instance()
            .set(&DataKey::State, &EscrowState::Disputed);

        env.events()
            .publish((symbol_short!("dispute"), config.funder.clone()), true);

        Ok(())
    }

    pub fn get_config(env: Env) -> Result<EscrowConfig, Error> {
        Self::config(&env)
    }

    pub fn get_state(env: Env) -> Result<EscrowState, Error> {
        Self::state(&env)
    }

    pub fn get_milestone(env: Env, milestone_id: u32) -> Result<Milestone, Error> {
        Self::milestone(&env, milestone_id)
    }

    pub fn get_proof(env: Env, milestone_id: u32) -> Result<BytesN<32>, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Proof(milestone_id))
            .ok_or(Error::NotFound)
    }
}

impl EscrowContract {
    fn config(env: &Env) -> Result<EscrowConfig, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInit)
    }

    fn state(env: &Env) -> Result<EscrowState, Error> {
        env.storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::NotInit)
    }

    fn milestone(env: &Env, milestone_id: u32) -> Result<Milestone, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Milestone(milestone_id))
            .ok_or(Error::NotFound)
    }

    fn assert_mutable(env: &Env) -> Result<(), Error> {
        match Self::state(env)? {
            EscrowState::Active => Ok(()),
            EscrowState::Disputed => Err(Error::Locked),
            _ => Err(Error::BadState),
        }
    }

    fn increment_approved(env: &Env) -> u32 {
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Approved)
            .unwrap_or(0);
        let next = count + 1;
        env.storage().instance().set(&DataKey::Approved, &next);
        next
    }
}
