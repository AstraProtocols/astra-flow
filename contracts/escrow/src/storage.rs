use soroban_sdk::{contracttype, Address, BytesN, Env, Vec};

use crate::Error;

/// Instance TTL: bump when remaining live ledgers drop below the threshold.
pub const INSTANCE_TTL_THRESHOLD: u32 = 100_000;
pub const INSTANCE_TTL_EXTEND_TO: u32 = 200_000;

/// Default proof lock window: 30 days of ledger time.
pub const DEFAULT_LOCK_WINDOW: u64 = 2_592_000;
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
    Paused,
    Amendment,
    Evidence,
    Arbitrators,
    PenaltyBps,
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

/// Execution state of an individual milestone.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MilestoneStatus {
    Pending = 0,
    UnderReview = 1,
    Released = 2,
    Disputed = 3,
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
    pub status: MilestoneStatus,
    pub submitted_at: u64,
    pub vesting_secs: u64,
    pub streamed: i128,
    pub deadline: u64,
    pub late_penalty_applied: bool,
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
    pub lock_secs: u64,
}

/// On-contract token accounting. `locked` is deposited minus released minus refunded.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BalanceBook {
    pub deposited: i128,
    pub released: i128,
    pub refunded: i128,
}

/// Dual-party scope change awaiting mutual approval.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Amendment {
    pub milestone_id: u32,
    pub payout_amount: i128,
    pub description_hash: BytesN<32>,
    pub new_position: u32,
    pub proposed_by: Address,
    pub funder_approved: bool,
    pub recipient_approved: bool,
}

/// Adjudication record for a disputed escrow.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeRecord {
    pub raised_by: Address,
    pub raised_at: u64,
    pub funder_bps: u32,
    pub recip_bps: u32,
    pub resolved: bool,
}

/// Cryptographic content hash submitted during an open dispute window.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvidenceEntry {
    pub submitter: Address,
    pub content_hash: BytesN<32>,
    pub submitted_at: u64,
}

/// M-of-N arbitrator committee bound to this escrow.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArbitratorSet {
    pub members: Vec<Address>,
    pub threshold: u32,
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

pub fn enter_guard(env: &Env) -> Result<(), Error> {
    let locked: bool = env
        .storage()
        .instance()
        .get(&DataKey::Guard)
        .unwrap_or(false);
    if locked {
        return Err(Error::Locked);
    }
    env.storage().instance().set(&DataKey::Guard, &true);
    bump_instance(env);
    Ok(())
}

pub fn exit_guard(env: &Env) {
    env.storage().instance().set(&DataKey::Guard, &false);
    bump_instance(env);
}

pub fn increment_approved(env: &Env) -> u32 {
    let next = get_approved_count(env).saturating_add(1);
    set_approved_count(env, next);
    next
}

pub fn set_dispute(env: &Env, dispute: &DisputeRecord) {
    let key = DataKey::Dispute;
    env.storage().persistent().set(&key, dispute);
    bump_persistent(env, &key);
}

pub fn get_dispute(env: &Env) -> Result<DisputeRecord, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Dispute)
        .ok_or(Error::NotFound)
}

pub fn set_lock_until(env: &Env, timestamp: u64) {
    env.storage()
        .instance()
        .set(&DataKey::LockUntil, &timestamp);
    bump_instance(env);
}

pub fn get_lock_until(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::LockUntil)
        .unwrap_or(0)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
    bump_instance(env);
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn set_amendment(env: &Env, amendment: &Amendment) {
    let key = DataKey::Amendment;
    env.storage().persistent().set(&key, amendment);
    bump_persistent(env, &key);
}

pub fn get_amendment(env: &Env) -> Result<Amendment, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Amendment)
        .ok_or(Error::NotFound)
}

pub fn clear_amendment(env: &Env) {
    env.storage().persistent().remove(&DataKey::Amendment);
}

pub const MAX_EVIDENCE: u32 = 32;

pub fn set_evidence(env: &Env, entries: &Vec<EvidenceEntry>) {
    let key = DataKey::Evidence;
    env.storage().persistent().set(&key, entries);
    bump_persistent(env, &key);
}

pub fn get_evidence(env: &Env) -> Vec<EvidenceEntry> {
    env.storage()
        .persistent()
        .get(&DataKey::Evidence)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_arbitrators(env: &Env, set: &ArbitratorSet) {
    let key = DataKey::Arbitrators;
    env.storage().persistent().set(&key, set);
    bump_persistent(env, &key);
}

pub fn get_arbitrators(env: &Env) -> Result<ArbitratorSet, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Arbitrators)
        .ok_or(Error::NotInit)
}

pub const DEFAULT_PENALTY_BPS: u32 = 500;

pub fn set_penalty_bps(env: &Env, bps: u32) {
    env.storage().instance().set(&DataKey::PenaltyBps, &bps);
    bump_instance(env);
}

pub fn get_penalty_bps(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::PenaltyBps)
        .unwrap_or(DEFAULT_PENALTY_BPS)
}
