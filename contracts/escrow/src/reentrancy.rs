use soroban_sdk::Env;

use crate::storage::DataKey;
use crate::Error;

/// Temporary-storage mutex lifetime: long enough for one invocation, short
/// enough that a failed transaction cannot linger as a cross-ledger lock.
const TEMP_TTL_THRESHOLD: u32 = 16;
const TEMP_TTL_EXTEND_TO: u32 = 32;

fn flag_locked(env: &Env) -> bool {
    env.storage()
        .temporary()
        .get(&DataKey::Guard)
        .unwrap_or(false)
}

/// Acquire the per-invocation mutex. Token transfers and allowance pulls must
/// run only while this flag is held so a malicious token cannot re-enter.
pub fn enter(env: &Env) -> Result<(), Error> {
    if flag_locked(env) {
        return Err(Error::Reentrancy);
    }
    let key = DataKey::Guard;
    env.storage().temporary().set(&key, &true);
    env.storage().temporary().extend_ttl(&key, TEMP_TTL_THRESHOLD, TEMP_TTL_EXTEND_TO);
    Ok(())
}

pub fn exit(env: &Env) {
    env.storage().temporary().set(&DataKey::Guard, &false);
}

/// Run `op` under the reentrancy mutex, always clearing the flag afterwards.
pub fn with_guard<F, T>(env: &Env, op: F) -> Result<T, Error>
where
    F: FnOnce() -> Result<T, Error>,
{
    enter(env)?;
    let result = op();
    exit(env);
    result
}
