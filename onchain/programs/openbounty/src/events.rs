use anchor_lang::prelude::*;

// Emitted for push notifications and indexers. Every event carries the escrow
// address and the bounty ID, so a listener can tell bounties apart without
// fetching an account. The fields are kept to what a notification needs; the
// full state is in the escrow account.

#[event]
pub struct BountyCreated {
    pub escrow: Pubkey,
    pub bounty_id: u64,
    pub organizer: Pubkey,
    pub mint: Pubkey,
    pub prize_total: u64,
}

// Emitted for every vote, including the one that decides a tier.
#[event]
pub struct VoteCast {
    pub escrow: Pubkey,
    pub bounty_id: u64,
    pub tier: u8,
    pub judge: Pubkey,
    pub candidate: Pubkey,
}

// Emitted after the VoteCast of the vote that brings a candidate to the
// threshold.
#[event]
pub struct TierFinalized {
    pub escrow: Pubkey,
    pub bounty_id: u64,
    pub tier: u8,
    pub winner: Pubkey,
    pub amount: u64,
}

// `amount` is what was actually paid, which on the final claim includes any
// tokens sent to the vault directly. `bounty_closed` is true when this claim
// closed the escrow and vault.
#[event]
pub struct PrizeClaimed {
    pub escrow: Pubkey,
    pub bounty_id: u64,
    pub tier: u8,
    pub winner: Pubkey,
    pub amount: u64,
    pub bounty_closed: bool,
}

// `amount` is the vault's whole balance returned to the organizer.
#[event]
pub struct BountyRefunded {
    pub escrow: Pubkey,
    pub bounty_id: u64,
    pub organizer: Pubkey,
    pub amount: u64,
}
