use soroban_sdk::contracterror;

/// Exhaustive on-chain error surface for Astra Flow escrow.
/// Numeric codes 1–16 are frozen for existing clients; 17+ are additive.
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
    BadToken = 11,
    BadRoles = 12,
    BadSequence = 13,
    AlreadySubmitted = 14,
    BadSplit = 15,
    TooEarly = 16,
    NotAuthorized = 17,
    MilestoneAlreadyCompleted = 18,
    InvalidMilestoneSequence = 19,
    DeadlineNotExceeded = 20,
    InsufficientAllowance = 21,
    ZeroAmountAllocated = 22,
    ArbitratorCollision = 23,
    DisputeLockActive = 24,
    Paused = 25,
    QuorumNotMet = 26,
    AmendmentPending = 27,
    VestingIncomplete = 28,
    PenaltyOverflow = 29,
    FeeOverflow = 30,
    Reentrancy = 31,
}

impl Error {
    /// Map a boolean auth check onto the granular authorization error.
    pub fn require_authorized(ok: bool) -> Result<(), Error> {
        if ok {
            Ok(())
        } else {
            Err(Error::NotAuthorized)
        }
    }

    /// Distinguish a live dispute freeze from a generic illegal-state failure.
    pub fn from_mutability(disputed: bool) -> Error {
        if disputed {
            Error::DisputeLockActive
        } else {
            Error::BadState
        }
    }

    /// Map non-positive payouts to a dedicated zero-allocation error.
    pub fn from_amount(amount: i128) -> Result<i128, Error> {
        if amount < 0 {
            Err(Error::BadAmount)
        } else if amount == 0 {
            Err(Error::ZeroAmountAllocated)
        } else {
            Ok(amount)
        }
    }

    pub const fn as_code(self) -> u32 {
        self as u32
    }
}
