#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Vec,
};

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = seed;
    BytesN::from_array(env, &bytes)
}

fn milestone(env: &Env, id: u32, amount: i128) -> Milestone {
    Milestone {
        milestone_id: id,
        payout_amount: amount,
        description_hash: hash(env, id as u8),
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

struct DisputeHarness {
    env: Env,
    client: EscrowContractClient<'static>,
    token: TokenClient<'static>,
    contract_id: Address,
    funder: Address,
    recipient: Address,
    arbitrator: Address,
}

fn funded(amount: i128) -> DisputeHarness {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| {
        ledger.timestamp = 1_800_000_000;
        ledger.sequence_number = 20_000;
    });

    let funder = Address::generate(&env);
    let recipient = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    StellarAssetClient::new(&env, &token_id).mint(&funder, &(amount * 2));
    let token = TokenClient::new(&env, &token_id);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let mut milestones = Vec::new(&env);
    milestones.push_back(milestone(&env, 1, amount));
    client.initialize(&funder, &recipient, &arbitrator, &token_id, &milestones);
    token.approve(
        &funder,
        &contract_id,
        &amount,
        &(env.ledger().sequence() + 1_000),
    );
    client.deposit_funds();

    DisputeHarness {
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
fn split_percentage_resolutions_cover_boundaries() {
    let cases: &[(u32, u32, i128, i128)] = &[
        (0, 10_000, 0, 80_000),
        (10_000, 0, 80_000, 0),
        (2_500, 7_500, 20_000, 60_000),
        (3_333, 6_667, 26_664, 53_336),
    ];

    for (funder_bps, recip_bps, funder_cut, recip_cut) in cases {
        let h = funded(80_000);
        let funder_before = h.token.balance(&h.funder);
        h.client.raise_dispute();
        h.client.resolve_dispute(funder_bps, recip_bps);
        assert_eq!(h.client.get_state(), EscrowState::Completed);
        assert_eq!(h.token.balance(&h.contract_id), 0);
        assert_eq!(h.token.balance(&h.funder), funder_before + funder_cut);
        assert_eq!(h.token.balance(&h.recipient), *recip_cut);
        let dispute = h.client.get_dispute();
        assert!(dispute.resolved);
        assert_eq!(dispute.funder_bps, *funder_bps);
        assert_eq!(dispute.recip_bps, *recip_bps);
    }
}

#[test]
fn split_percentage_rejects_incomplete_bps() {
    let h = funded(50_000);
    h.client.raise_dispute();
    assert!(h.client.try_resolve_dispute(&5_000, &4_000).is_err());
    assert!(h.client.try_resolve_dispute(&10_001, &0).is_err());
    assert_eq!(h.client.get_state(), EscrowState::Disputed);
    assert_eq!(h.token.balance(&h.contract_id), 50_000);
}

#[test]
fn evidence_registry_accepts_party_hashes_and_rejects_injection() {
    let h = funded(25_000);
    let outsider = Address::generate(&h.env);
    assert!(h
        .client
        .try_append_dispute_evidence(&h.funder, &hash(&h.env, 1))
        .is_err());

    h.client.raise_dispute();
    let first = h
        .client
        .append_dispute_evidence(&h.funder, &hash(&h.env, 11));
    assert_eq!(first, 1);
    let second = h
        .client
        .append_dispute_evidence(&h.recipient, &hash(&h.env, 12));
    assert_eq!(second, 2);

    assert!(h
        .client
        .try_append_dispute_evidence(&outsider, &hash(&h.env, 13))
        .is_err());
    assert!(h
        .client
        .try_append_dispute_evidence(&h.funder, &hash(&h.env, 11))
        .is_err());
    assert!(h
        .client
        .try_append_dispute_evidence(&h.recipient, &BytesN::from_array(&h.env, &[0u8; 32]))
        .is_err());

    let docket = h.client.get_evidence();
    assert_eq!(docket.len(), 2);
    assert_eq!(docket.get(0).unwrap().submitter, h.funder);
    assert_eq!(docket.get(1).unwrap().submitter, h.recipient);

    h.client.resolve_dispute(&5_000, &5_000);
    assert!(h
        .client
        .try_append_dispute_evidence(&h.funder, &hash(&h.env, 99))
        .is_err());
}

#[test]
fn quorum_settlement_requires_m_of_n_committee_signers() {
    let h = funded(40_000);
    let arb_a = h.arbitrator.clone();
    let arb_b = Address::generate(&h.env);
    let arb_c = Address::generate(&h.env);
    let impostor = Address::generate(&h.env);

    let mut members = Vec::new(&h.env);
    members.push_back(arb_a.clone());
    members.push_back(arb_b.clone());
    members.push_back(arb_c.clone());
    h.client.configure_arbitrators(&members, &2);

    h.client.raise_dispute();

    let mut one = Vec::new(&h.env);
    one.push_back(arb_a.clone());
    assert!(h
        .client
        .try_settle_dispute_quorum(&4_000, &6_000, &one)
        .is_err());

    let mut dup = Vec::new(&h.env);
    dup.push_back(arb_a.clone());
    dup.push_back(arb_a.clone());
    assert!(h
        .client
        .try_settle_dispute_quorum(&4_000, &6_000, &dup)
        .is_err());

    let mut outsider = Vec::new(&h.env);
    outsider.push_back(arb_a.clone());
    outsider.push_back(impostor);
    assert!(h
        .client
        .try_settle_dispute_quorum(&4_000, &6_000, &outsider)
        .is_err());
    assert_eq!(h.client.get_state(), EscrowState::Disputed);
    assert_eq!(h.token.balance(&h.contract_id), 40_000);

    let mut quorum = Vec::new(&h.env);
    quorum.push_back(arb_b);
    quorum.push_back(arb_c);
    h.client.settle_dispute_quorum(&4_000, &6_000, &quorum);
    assert_eq!(h.client.get_state(), EscrowState::Completed);
    assert!(h.client.get_dispute().resolved);
    assert_eq!(h.token.balance(&h.contract_id), 0);
    assert_eq!(h.token.balance(&h.recipient), 24_000);
}

#[test]
fn single_arbitrator_quorum_matches_legacy_resolve() {
    let h = funded(10_000);
    h.client.raise_dispute();
    let mut signers = Vec::new(&h.env);
    signers.push_back(h.arbitrator.clone());
    h.client.settle_dispute_quorum(&2_000, &8_000, &signers);
    assert_eq!(h.token.balance(&h.recipient), 8_000);
    assert_eq!(h.client.get_dispute().funder_bps, 2_000);
}
