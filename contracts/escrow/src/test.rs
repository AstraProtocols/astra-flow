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
    }
}

#[test]
fn initialize_and_deposit_then_release_milestone() {
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

    let total: i128 = 300_000;
    stellar_asset.mint(&funder, &(total * 2));

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let mut milestones = Vec::new(&env);
    milestones.push_back(sample_milestone(&env, 1, 100_000, 1));
    milestones.push_back(sample_milestone(&env, 2, 200_000, 2));

    client.initialize(&funder, &recipient, &arbitrator, &token_id, &milestones);

    assert_eq!(client.get_state(), EscrowState::Pending);
    let config = client.get_config();
    assert_eq!(config.funder, funder);
    assert_eq!(config.recipient, recipient);
    assert_eq!(config.arbitrator, arbitrator);
    assert_eq!(config.asset, token_id);
    assert_eq!(config.total_amount, total);
    assert_eq!(config.release_threshold, 2);

    let expiration = env.ledger().sequence() + 1_000;
    token.approve(&funder, &contract_id, &total, &expiration);
    assert_eq!(token.allowance(&funder, &contract_id), total);

    client.deposit_funds();

    assert_eq!(client.get_state(), EscrowState::Active);
    assert_eq!(token.balance(&contract_id), total);
    assert_eq!(token.balance(&funder), total);

    let proof = proof_hash(&env, 42);
    client.submit_milestone_proof(&1, &proof);
    assert_eq!(client.get_proof(&1), proof);

    client.approve_milestone(&1);

    let first = client.get_milestone(&1);
    assert!(first.is_approved);
    assert_eq!(first.completed_at, 1_700_000_000);
    assert_eq!(token.balance(&recipient), 100_000);
    assert_eq!(token.balance(&contract_id), 200_000);
    assert_eq!(client.get_state(), EscrowState::Active);

    client.approve_milestone(&2);
    assert_eq!(token.balance(&recipient), total);
    assert_eq!(token.balance(&contract_id), 0);
    assert_eq!(client.get_state(), EscrowState::Completed);
}

#[test]
fn dispute_locks_unreleased_milestones() {
    let env = Env::default();
    env.mock_all_auths();

    let funder = Address::generate(&env);
    let recipient = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let admin = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin);
    let token_id = sac.address();
    StellarAssetClient::new(&env, &token_id).mint(&funder, &50_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let mut milestones = Vec::new(&env);
    milestones.push_back(sample_milestone(&env, 7, 50_000, 7));

    client.initialize(&funder, &recipient, &arbitrator, &token_id, &milestones);

    let token = TokenClient::new(&env, &token_id);
    token.approve(&funder, &contract_id, &50_000, &(env.ledger().sequence() + 100));
    client.deposit_funds();

    client.raise_dispute();
    assert_eq!(client.get_state(), EscrowState::Disputed);

    let result = client.try_submit_milestone_proof(&7, &proof_hash(&env, 9));
    assert!(result.is_err());

    client.approve_milestone(&7);
    assert_eq!(client.get_state(), EscrowState::Completed);
    assert_eq!(token.balance(&recipient), 50_000);
}
