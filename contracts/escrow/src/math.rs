use crate::Error;

/// Canonical basis-point scale: 10_000 bps = 100%.
pub const BPS_SCALE: u32 = 10_000;
pub const BPS_SCALE_I128: i128 = 10_000;

/// Reject splits that overflow or do not consume the full 10_000 bps.
pub fn require_full_bps(left_bps: u32, right_bps: u32) -> Result<(), Error> {
    let sum = left_bps.checked_add(right_bps).ok_or(Error::BadSplit)?;
    if sum != BPS_SCALE {
        Err(Error::BadSplit)
    } else {
        Ok(())
    }
}

/// Floor(`amount * bps / 10_000`) with overflow checks. Never rounds up.
pub fn apply_bps(amount: i128, bps: u32) -> Result<i128, Error> {
    if amount < 0 {
        return Err(Error::BadAmount);
    }
    if bps > BPS_SCALE {
        return Err(Error::PenaltyOverflow);
    }
    let scaled = amount
        .checked_mul(i128::from(bps))
        .ok_or(Error::FeeOverflow)?;
    scaled.checked_div(BPS_SCALE_I128).ok_or(Error::FeeOverflow)
}

/// Allocate `total` by milestone weight, rounding down so dust stays unallocated.
pub fn ratio_share(total: i128, weight_bps: u32) -> Result<i128, Error> {
    apply_bps(total, weight_bps)
}

/// Split an escrow remainder into funder / recipient legs. Remainder after the
/// funder floor share is assigned to the recipient so the two legs always
/// reconstruct `amount` exactly when bps sum to `BPS_SCALE`.
pub fn split_amount(
    amount: i128,
    funder_bps: u32,
    recip_bps: u32,
) -> Result<(i128, i128), Error> {
    require_full_bps(funder_bps, recip_bps)?;
    let funder_amt = apply_bps(amount, funder_bps)?;
    let recip_amt = amount.checked_sub(funder_amt).ok_or(Error::BadAmount)?;
    Ok((funder_amt, recip_amt))
}

/// Protocol treasury take: `(fee, net_to_recipient)` with floor rounding so the
/// fee never exceeds the configured percentage.
pub fn protocol_fee(gross: i128, fee_bps: u32) -> Result<(i128, i128), Error> {
    let fee = apply_bps(gross, fee_bps)?;
    let net = gross.checked_sub(fee).ok_or(Error::FeeOverflow)?;
    Ok((fee, net))
}

/// Late-delivery slash: `(penalty, remaining_payout)`. Dust from floor division
/// stays in `remaining_payout` rather than inflating the slash.
pub fn apply_penalty(gross: i128, penalty_bps: u32) -> Result<(i128, i128), Error> {
    let slash = apply_bps(gross, penalty_bps)?;
    let remaining = gross.checked_sub(slash).ok_or(Error::PenaltyOverflow)?;
    Ok((slash, remaining))
}

/// Integer division that always floors toward zero for non-negative inputs.
pub fn floor_div(numer: i128, denom: i128) -> Result<i128, Error> {
    if numer < 0 || denom <= 0 {
        return Err(Error::BadAmount);
    }
    numer.checked_div(denom).ok_or(Error::BadAmount)
}

/// Linear vesting unlock between `start` and `end` (exclusive of start).
/// Returns 0 before `start`, `total` at/after `end`, and a floored interpolant
/// in between so streamed payouts never overshoot the milestone allocation.
pub fn vested_amount(total: i128, start: u64, end: u64, now: u64) -> Result<i128, Error> {
    if total < 0 {
        return Err(Error::BadAmount);
    }
    if end <= start {
        return Err(Error::BadAmount);
    }
    if now <= start {
        return Ok(0);
    }
    if now >= end {
        return Ok(total);
    }
    let elapsed = i128::from(now.saturating_sub(start));
    let duration = i128::from(end.saturating_sub(start));
    let product = total.checked_mul(elapsed).ok_or(Error::FeeOverflow)?;
    floor_div(product, duration)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_bps_floors_and_rejects_overflow_inputs() {
        assert_eq!(apply_bps(1_000, 2_500).unwrap(), 250);
        assert_eq!(apply_bps(3, 1).unwrap(), 0);
        assert_eq!(apply_bps(0, 10_000).unwrap(), 0);
        assert_eq!(apply_bps(10, 10_000).unwrap(), 10);
        assert_eq!(apply_bps(1, BPS_SCALE + 1), Err(Error::PenaltyOverflow));
        assert_eq!(apply_bps(-1, 100), Err(Error::BadAmount));
        assert_eq!(
            apply_bps(i128::MAX, 2),
            Err(Error::FeeOverflow)
        );
    }

    #[test]
    fn split_amount_reconstructs_principal() {
        let (f, r) = split_amount(1_000, 2_500, 7_500).unwrap();
        assert_eq!(f, 250);
        assert_eq!(r, 750);
        let (f, r) = split_amount(7, 3_333, 6_667).unwrap();
        assert_eq!(f + r, 7);
        assert_eq!(split_amount(100, 4_000, 5_000), Err(Error::BadSplit));
    }

    #[test]
    fn protocol_fee_and_penalty_never_exceed_gross() {
        let (fee, net) = protocol_fee(10_000, 250).unwrap();
        assert_eq!(fee, 250);
        assert_eq!(net, 9_750);
        let (slash, rest) = apply_penalty(999, 100).unwrap();
        assert_eq!(slash + rest, 999);
        assert!(slash <= 999);
        assert_eq!(ratio_share(1_000_000, 1_250).unwrap(), 125_000);
    }

    #[test]
    fn vested_amount_floors_and_clamps() {
        assert_eq!(vested_amount(1_000, 10, 20, 10).unwrap(), 0);
        assert_eq!(vested_amount(1_000, 10, 20, 15).unwrap(), 500);
        assert_eq!(vested_amount(1_000, 10, 20, 20).unwrap(), 1_000);
        assert_eq!(vested_amount(7, 0, 3, 1).unwrap(), 2);
        assert_eq!(vested_amount(100, 5, 5, 5), Err(Error::BadAmount));
    }
}
