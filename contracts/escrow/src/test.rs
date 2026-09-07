#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Vec,
};

fn proof_hash(env: &Env, seed: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = seed;
    BytesN::from_array(env, &bytes)
}

fn sample_milestone(env: &Env, id: u32, amount: i128, seed: u8) -> Milestone {
    Milestone {
        milestone_id: id,
        payout_amount: amount,
        description_hash: proof_hash(env, seed),
        is_approved: false,
        completed_at: 0,
        status: MilestoneStatus::Pending,
        submitted_at: 0,
        vesting_secs: 0,
        streamed: 0,
        deadline: 0,
        late_penalty_applied: false,
    }
}

struct Harness {
    env: Env,
    client: EscrowContractClient<'static>,
    token: TokenClient<'static>,
    contract_id: Address,
    funder: Address,
    recipient: Address,
    arbitrator: Address,
}

fn setup(amounts: &[i128]) -> Harness {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| {
        ledger.timestamp = 1_700_000_000;
        ledger.sequence_number = 10_000;
    });

    let funder = Address::generate(&env);
    let recipient = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let admin = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin);
    let token_id = sac.address();
    let stellar_asset = StellarAssetClient::new(&env, &token_id);
    let token = TokenClient::new(&env, &token_id);

    let total: i128 = amounts.iter().copied().sum();
    stellar_asset.mint(&funder, &(total * 2));

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let mut milestones = Vec::new(&env);
    for (index, amount) in amounts.iter().enumerate() {
        let id = (index as u32) + 1;
        milestones.push_back(sample_milestone(&env, id, *amount, id as u8));
    }

    client.initialize(&funder, &recipient, &arbitrator, &token_id, &milestones);
    token.approve(
        &funder,
        &contract_id,
        &total,
        &(env.ledger().sequence() + 1_000),
    );

    Harness {
        env,
        client,
        token,
        contract_id,
        funder,
        recipient,
        arbitrator,
    }
}

#[test]
fn initialize_and_deposit_then_release_milestone() {
    let h = setup(&[100_000, 200_000]);
    let total: i128 = 300_000;

    assert_eq!(h.client.get_state(), EscrowState::Pending);
    let config = h.client.get_config();
    assert_eq!(config.funder, h.funder);
    assert_eq!(config.recipient, h.recipient);
    assert_eq!(config.arbitrator, h.arbitrator);
    assert_eq!(config.total_amount, total);
    assert_eq!(config.release_threshold, 2);
    assert_eq!(config.lock_secs, storage::DEFAULT_LOCK_WINDOW);

    h.client.deposit_funds();
    assert_eq!(h.client.get_state(), EscrowState::Active);
    assert_eq!(h.token.balance(&h.contract_id), total);
    assert_eq!(h.token.balance(&h.funder), total);

    let proof = proof_hash(&h.env, 42);
    h.client.submit_milestone_proof(&1, &proof);
    assert_eq!(h.client.get_proof(&1), proof);
    let under_review = h.client.get_milestone(&1);
    assert_eq!(under_review.status, MilestoneStatus::UnderReview);
    assert_eq!(under_review.submitted_at, 1_700_000_000);

    h.client.approve_milestone(&1);
    let first = h.client.get_milestone(&1);
    assert!(first.is_approved);
    assert_eq!(first.status, MilestoneStatus::Released);
    assert_eq!(first.completed_at, 1_700_000_000);
    assert_eq!(h.token.balance(&h.recipient), 100_000);
    assert_eq!(h.token.balance(&h.contract_id), 200_000);
    assert_eq!(h.client.get_state(), EscrowState::Active);

    h.client.submit_milestone_proof(&2, &proof_hash(&h.env, 43));
    h.client.approve_milestone(&2);
    assert_eq!(h.token.balance(&h.recipient), total);
    assert_eq!(h.token.balance(&h.contract_id), 0);
    assert_eq!(h.client.get_state(), EscrowState::Completed);
}

#[test]
fn rejects_unauthorized_and_invalid_lifecycle_calls() {
    let env = Env::default();
    env.mock_all_auths();
    let funder = Address::generate(&env);
    let recipient = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    StellarAssetClient::new(&env, &token_id).mint(&funder, &10_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let mut bad_sequence = Vec::new(&env);
    bad_sequence.push_back(sample_milestone(&env, 2, 10_000, 1));
    assert!(client
        .try_initialize(&funder, &recipient, &arbitrator, &token_id, &bad_sequence)
        .is_err());

    let mut same_roles = Vec::new(&env);
    same_roles.push_back(sample_milestone(&env, 1, 10_000, 1));
    assert!(client
        .try_initialize(&funder, &funder, &arbitrator, &token_id, &same_roles)
        .is_err());

    client.initialize(&funder, &recipient, &arbitrator, &token_id, &same_roles);
    assert!(client
        .try_initialize(&funder, &recipient, &arbitrator, &token_id, &same_roles)
        .is_err());
    assert!(client
        .try_submit_milestone_proof(&1, &proof_hash(&env, 1))
        .is_err());
    assert!(client.try_approve_milestone(&1).is_err());
    assert!(client.try_raise_dispute().is_err());
    assert!(client.try_claim_timeout_refund().is_err());
}

#[test]
fn dispute_split_pays_funder_and_recipient() {
    let h = setup(&[40_000, 60_000]);
    h.client.deposit_funds();
    h.client.submit_milestone_proof(&1, &proof_hash(&h.env, 1));
    h.client.approve_milestone(&1);

    assert_eq!(h.token.balance(&h.recipient), 40_000);
    assert_eq!(h.token.balance(&h.contract_id), 60_000);

    h.client.raise_dispute();
    assert_eq!(h.client.get_state(), EscrowState::Disputed);
    assert!(h
        .client
        .try_submit_milestone_proof(&2, &proof_hash(&h.env, 2))
        .is_err());

    let dispute = h.client.get_dispute();
    assert!(!dispute.resolved);

    h.client.resolve_dispute(&2_500, &7_500);

    assert_eq!(h.client.get_state(), EscrowState::Completed);
    assert!(h.client.get_dispute().resolved);
    assert_eq!(h.token.balance(&h.contract_id), 0);
    assert_eq!(h.token.balance(&h.funder), 100_000 + 15_000);
    assert_eq!(h.token.balance(&h.recipient), 40_000 + 45_000);
}

#[test]
fn timeout_refund_returns_locked_balance_to_funder() {
    let h = setup(&[50_000]);
    h.client.deposit_funds();
    assert!(h.client.try_claim_timeout_refund().is_err());

    h.env.ledger().with_mut(|ledger| {
        ledger.timestamp = 1_700_000_000 + storage::DEFAULT_LOCK_WINDOW;
    });

    h.client.claim_timeout_refund();
    assert_eq!(h.client.get_state(), EscrowState::Cancelled);
    assert_eq!(h.token.balance(&h.contract_id), 0);
    assert_eq!(h.token.balance(&h.funder), 100_000);
}

#[test]
fn dispute_locks_unreleased_milestones() {
    let h = setup(&[50_000]);
    h.client.deposit_funds();
    h.client.raise_dispute();
    assert_eq!(h.client.get_state(), EscrowState::Disputed);
    assert!(h
        .client
        .try_submit_milestone_proof(&1, &proof_hash(&h.env, 9))
        .is_err());

    h.client.approve_milestone(&1);
    assert_eq!(h.client.get_state(), EscrowState::Completed);
    assert_eq!(h.token.balance(&h.recipient), 50_000);
}
