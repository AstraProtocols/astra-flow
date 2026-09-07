use soroban_sdk::Env;

use crate::storage::{
    self, DataKey, INSTANCE_TTL_EXTEND_TO, INSTANCE_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO,
    PERSISTENT_TTL_THRESHOLD,
};

/// Extend instance TTL when remaining live ledgers drop below the threshold.
pub fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

/// Extend a persistent entry if it exists. Missing keys are skipped so callers
/// can bump a key set without probing `has` themselves.
pub fn extend_persistent(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        env.storage().persistent().extend_ttl(
            key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND_TO,
        );
    }
}

/// Bump every persistent record that is written during escrow construction.
pub fn extend_on_initialize(env: &Env) {
    extend_instance(env);
    extend_persistent(env, &DataKey::Balances);
    extend_persistent(env, &DataKey::Milestones);
    let ids = storage::get_milestone_ids(env);
    for id in ids.iter() {
        extend_persistent(env, &DataKey::Milestone(id));
    }
}

/// Keep proof + milestone records live after a recipient submission.
pub fn extend_on_proof_submitted(env: &Env, milestone_id: u32) {
    extend_instance(env);
    extend_persistent(env, &DataKey::Milestone(milestone_id));
    extend_persistent(env, &DataKey::Proof(milestone_id));
    extend_persistent(env, &DataKey::Milestones);
    extend_persistent(env, &DataKey::Balances);
}

/// Full-book refresh used by long-lived mutating entrypoints.
pub fn extend_all_persistent(env: &Env) {
    extend_instance(env);
    extend_persistent(env, &DataKey::Balances);
    extend_persistent(env, &DataKey::Milestones);
    extend_persistent(env, &DataKey::Dispute);
    let ids = storage::get_milestone_ids(env);
    for id in ids.iter() {
        extend_persistent(env, &DataKey::Milestone(id));
        extend_persistent(env, &DataKey::Proof(id));
    }
}
