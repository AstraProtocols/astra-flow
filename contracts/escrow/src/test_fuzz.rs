#![cfg(test)]

use super::*;

struct Lcg(u64);

impl Lcg {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        self.0
    }

    fn amount(&mut self) -> i128 {
        (self.next_u64() % 50_000_000) as i128
    }

    fn bps(&mut self) -> u32 {
        (self.next_u64() % (u64::from(BPS_SCALE) + 1)) as u32
    }

    fn span(&mut self) -> u64 {
        (self.next_u64() % 86_400) + 1
    }
}

#[test]
fn fuzz_split_amount_always_reconstructs_principal() {
    let mut rng = Lcg(0xA5F10CE5C);
    for _ in 0..256 {
        let amount = rng.amount();
        let funder_bps = rng.bps();
        let recip_bps = BPS_SCALE.saturating_sub(funder_bps);
        let (funder_amt, recip_amt) = split_amount(amount, funder_bps, recip_bps).unwrap();
        assert_eq!(funder_amt + recip_amt, amount);
        assert!(funder_amt >= 0 && recip_amt >= 0);
        if amount > 0 && funder_bps == 0 {
            assert_eq!(funder_amt, 0);
        }
        if amount > 0 && funder_bps == BPS_SCALE {
            assert_eq!(recip_amt, 0);
        }
    }
}

#[test]
fn fuzz_penalty_and_fee_never_exceed_gross() {
    let mut rng = Lcg(0xFEE5B0B0);
    for _ in 0..256 {
        let gross = rng.amount();
        let bps = rng.bps();
        let (slash, rest) = apply_penalty(gross, bps).unwrap();
        assert_eq!(slash + rest, gross);
        assert!(slash <= gross);
        let (fee, net) = protocol_fee(gross, bps).unwrap();
        assert_eq!(fee + net, gross);
        assert!(fee <= gross);
        let share = ratio_share(gross, bps).unwrap();
        assert!(share <= gross);
        if bps == 0 {
            assert_eq!(slash, 0);
            assert_eq!(fee, 0);
        }
        if bps == BPS_SCALE {
            assert_eq!(slash, gross);
            assert_eq!(fee, gross);
        }
    }
}

#[test]
fn fuzz_apply_bps_is_floor_and_rejects_out_of_range() {
    let mut rng = Lcg(0xF100D);
    for _ in 0..128 {
        let amount = rng.amount();
        let bps = rng.bps();
        let got = apply_bps(amount, bps).unwrap();
        let exact = amount.checked_mul(i128::from(bps)).unwrap() / BPS_SCALE_I128;
        assert_eq!(got, exact);
        assert!(got <= amount);
    }
    assert_eq!(apply_bps(10, BPS_SCALE + 1), Err(Error::PenaltyOverflow));
    assert_eq!(apply_bps(-5, 100), Err(Error::BadAmount));
    assert_eq!(apply_bps(i128::MAX, 2), Err(Error::FeeOverflow));
}

#[test]
fn fuzz_vesting_is_monotonic_and_bounded() {
    let mut rng = Lcg(0x5EED51E4);
    for _ in 0..192 {
        let total = rng.amount().max(1);
        let start = rng.next_u64() % 1_000_000;
        let duration = rng.span();
        let end = start.saturating_add(duration);
        let mut previous = 0i128;
        for step in 0..=8 {
            let now = start.saturating_add((duration * step) / 8);
            let vested = vested_amount(total, start, end, now).unwrap();
            assert!(vested >= previous);
            assert!(vested <= total);
            previous = vested;
        }
        assert_eq!(vested_amount(total, start, end, start).unwrap(), 0);
        assert_eq!(vested_amount(total, start, end, end).unwrap(), total);
        assert_eq!(vested_amount(total, start, end, end + 10).unwrap(), total);
    }
    assert_eq!(vested_amount(100, 10, 10, 10), Err(Error::BadAmount));
    assert_eq!(vested_amount(-1, 0, 10, 5), Err(Error::BadAmount));
}

#[test]
fn fuzz_floor_div_boundaries() {
    let mut rng = Lcg(42);
    for _ in 0..64 {
        let numer = rng.amount();
        let denom = rng.amount().max(1);
        let q = floor_div(numer, denom).unwrap();
        assert_eq!(q, numer / denom);
        assert!(q * denom <= numer);
    }
    assert_eq!(floor_div(10, 0), Err(Error::BadAmount));
    assert_eq!(floor_div(-1, 2), Err(Error::BadAmount));
}
