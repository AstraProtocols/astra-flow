use soroban_sdk::{contractevent, token, Address, Env};

use crate::storage::{self, BalanceBook, EscrowState};
use crate::Error;

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundsDeposited {
    #[topic]
    pub funder: Address,
    pub amount: i128,
}

/// Pull the funder's SEP-41 allowance into the escrow and credit the balance book.
pub fn deposit_funds(env: &Env) -> Result<(), Error> {
    let config = storage::get_config(env)?;
    config.funder.require_auth();

    let state = storage::get_state(env)?;
    if state != EscrowState::Pending {
        return Err(Error::BadState);
    }

    let mut book = storage::get_balances(env);
    if book.deposited > 0 {
        return Err(Error::AlreadyPaid);
    }

    let token_client = token::Client::new(env, &config.asset);
    let allowance = token_client.allowance(&config.funder, &env.current_contract_address());
    if allowance < config.total_amount {
        return Err(Error::NoDeposit);
    }

    token_client.transfer_from(
        &env.current_contract_address(),
        &config.funder,
        &env.current_contract_address(),
        &config.total_amount,
    );

    let held = token_client.balance(&env.current_contract_address());
    if held < config.total_amount {
        return Err(Error::NoDeposit);
    }

    book.deposited = config.total_amount;
    storage::set_balances(env, &book);
    storage::set_state(env, &EscrowState::Active);

    FundsDeposited {
        funder: config.funder.clone(),
        amount: config.total_amount,
    }
    .publish(env);

    Ok(())
}

pub fn transfer_to(env: &Env, to: &Address, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::BadAmount);
    }
    let config = storage::get_config(env)?;
    let token_client = token::Client::new(env, &config.asset);
    token_client.transfer(&env.current_contract_address(), to, &amount);
    Ok(())
}

pub fn credit_released(env: &Env, amount: i128) -> Result<BalanceBook, Error> {
    let mut book = storage::get_balances(env);
    book.released = book.released.checked_add(amount).ok_or(Error::BadAmount)?;
    if book.locked() < 0 {
        return Err(Error::BadAmount);
    }
    storage::set_balances(env, &book);
    Ok(book)
}

pub fn assert_sep41_token(env: &Env, asset: &Address) -> Result<(), Error> {
    let client = token::Client::new(env, asset);
    match client.try_decimals() {
        Ok(Ok(value)) if value > 0 && value <= 18 => Ok(()),
        _ => Err(Error::BadToken),
    }
}

pub fn credit_refunded(env: &Env, amount: i128) -> Result<BalanceBook, Error> {
    let mut book = storage::get_balances(env);
    if amount > book.locked() {
        return Err(Error::BadAmount);
    }
    book.refunded = book.refunded.checked_add(amount).ok_or(Error::BadAmount)?;
    storage::set_balances(env, &book);
    Ok(book)
}
