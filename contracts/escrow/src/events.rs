use soroban_sdk::{contractevent, Address, BytesN, Env};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowInitialized {
    #[topic]
    pub funder: Address,
    pub recipient: Address,
    pub arbitrator: Address,
    pub token: Address,
    pub total: i128,
    pub count: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneCreated {
    #[topic]
    pub milestone: u32,
    pub amount: i128,
    pub desc: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneSubmitted {
    #[topic]
    pub milestone: u32,
    pub recipient: Address,
    pub proof: BytesN<32>,
    pub at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneApproved {
    #[topic]
    pub milestone: u32,
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeRaised {
    #[topic]
    pub raised_by: Address,
    pub at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeSettled {
    #[topic]
    pub arbitrator: Address,
    pub funder_bps: u32,
    pub recip_bps: u32,
    pub funder_amt: i128,
    pub recip_amt: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmergencyPaused {
    #[topic]
    pub admin: Address,
    pub paused: bool,
    pub at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimeoutRefunded {
    #[topic]
    pub funder: Address,
    pub amount: i128,
    pub at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundsDeposited {
    #[topic]
    pub funder: Address,
    pub amount: i128,
}

pub fn emit_initialized(
    env: &Env,
    funder: Address,
    recipient: Address,
    arbitrator: Address,
    token: Address,
    total: i128,
    count: u32,
) {
    EscrowInitialized {
        funder,
        recipient,
        arbitrator,
        token,
        total,
        count,
    }
    .publish(env);
}

pub fn emit_milestone_created(env: &Env, milestone: u32, amount: i128, desc: BytesN<32>) {
    MilestoneCreated {
        milestone,
        amount,
        desc,
    }
    .publish(env);
}

pub fn emit_milestone_submitted(
    env: &Env,
    milestone: u32,
    recipient: Address,
    proof: BytesN<32>,
    at: u64,
) {
    MilestoneSubmitted {
        milestone,
        recipient,
        proof,
        at,
    }
    .publish(env);
}

pub fn emit_milestone_approved(env: &Env, milestone: u32, recipient: Address, amount: i128) {
    MilestoneApproved {
        milestone,
        recipient,
        amount,
    }
    .publish(env);
}

pub fn emit_dispute_raised(env: &Env, raised_by: Address, at: u64) {
    DisputeRaised { raised_by, at }.publish(env);
}

pub fn emit_dispute_settled(
    env: &Env,
    arbitrator: Address,
    funder_bps: u32,
    recip_bps: u32,
    funder_amt: i128,
    recip_amt: i128,
) {
    DisputeSettled {
        arbitrator,
        funder_bps,
        recip_bps,
        funder_amt,
        recip_amt,
    }
    .publish(env);
}

pub fn emit_emergency_paused(env: &Env, admin: Address, paused: bool, at: u64) {
    EmergencyPaused {
        admin,
        paused,
        at,
    }
    .publish(env);
}

pub fn emit_timeout_refunded(env: &Env, funder: Address, amount: i128, at: u64) {
    TimeoutRefunded {
        funder,
        amount,
        at,
    }
    .publish(env);
}

pub fn emit_funds_deposited(env: &Env, funder: Address, amount: i128) {
    FundsDeposited { funder, amount }.publish(env);
}
