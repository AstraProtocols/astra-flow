use soroban_sdk::{contracttype, Address, BytesN, Env, Vec};

use crate::Error;

/// Instance TTL: bump when remaining live ledgers drop below the threshold.
pub const INSTANCE_TTL_THRESHOLD: u32 = 100_000;
pub const INSTANCE_TTL_EXTEND_TO: u32 = 200_000;

/// Persistent TTL for milestone records, proofs, and balance books.
pub const PERSISTENT_TTL_THRESHOLD: u32 = 100_000;
pub const PERSISTENT_TTL_EXTEND_TO: u32 = 535_679;

/// Storage keys. Instance keys hold protocol-wide config; persistent keys
/// hold per-milestone records that must survive archival independently.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Config,
    State,
    Balances,
    Milestones,
    Milestone(u32),
    Proof(u32),
    Approved,
    LockUntil,
    Dispute,
    Guard,
}

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

/// On-contract token accounting. `locked` is deposited minus released minus refunded.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BalanceBook {
    pub deposited: i128,
    pub released: i128,
    pub refunded: i128,
}

impl BalanceBook {
    pub fn empty() -> Self {
        Self {
            deposited: 0,
            released: 0,
            refunded: 0,
        }
    }

    pub fn locked(&self) -> i128 {
        self.deposited
            .saturating_sub(self.released)
            .saturating_sub(self.refunded)
    }
}

pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

pub fn bump_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
}

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Config)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
    bump_instance(env);
}

pub fn get_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInit)
}

pub fn set_config(env: &Env, config: &EscrowConfig) {
    env.storage().instance().set(&DataKey::Config, config);
    bump_instance(env);
}

pub fn get_config(env: &Env) -> Result<EscrowConfig, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::NotInit)
}

pub fn set_state(env: &Env, state: &EscrowState) {
    env.storage().instance().set(&DataKey::State, state);
    bump_instance(env);
}

pub fn get_state(env: &Env) -> Result<EscrowState, Error> {
    env.storage()
        .instance()
        .get(&DataKey::State)
        .ok_or(Error::NotInit)
}

pub fn set_balances(env: &Env, book: &BalanceBook) {
    let key = DataKey::Balances;
    env.storage().persistent().set(&key, book);
    bump_persistent(env, &key);
    bump_instance(env);
}

pub fn get_balances(env: &Env) -> BalanceBook {
    env.storage()
        .persistent()
        .get(&DataKey::Balances)
        .unwrap_or_else(BalanceBook::empty)
}

pub fn set_milestone_ids(env: &Env, ids: &Vec<u32>) {
    let key = DataKey::Milestones;
    env.storage().persistent().set(&key, ids);
    bump_persistent(env, &key);
}

pub fn get_milestone_ids(env: &Env) -> Vec<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::Milestones)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_milestone(env: &Env, milestone: &Milestone) {
    let key = DataKey::Milestone(milestone.milestone_id);
    env.storage().persistent().set(&key, milestone);
    bump_persistent(env, &key);
}

pub fn get_milestone(env: &Env, milestone_id: u32) -> Result<Milestone, Error> {
    let key = DataKey::Milestone(milestone_id);
    let milestone = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    bump_persistent(env, &key);
    Ok(milestone)
}

pub fn set_proof(env: &Env, milestone_id: u32, proof: &BytesN<32>) {
    let key = DataKey::Proof(milestone_id);
    env.storage().persistent().set(&key, proof);
    bump_persistent(env, &key);
}

pub fn get_proof(env: &Env, milestone_id: u32) -> Result<BytesN<32>, Error> {
    let key = DataKey::Proof(milestone_id);
    let proof = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    bump_persistent(env, &key);
    Ok(proof)
}

pub fn set_approved_count(env: &Env, count: u32) {
    env.storage().instance().set(&DataKey::Approved, &count);
    bump_instance(env);
}

pub fn get_approved_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::Approved)
        .unwrap_or(0)
}

pub fn increment_approved(env: &Env) -> u32 {
    let next = get_approved_count(env).saturating_add(1);
    set_approved_count(env, next);
    next
}
