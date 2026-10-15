use anchor_lang::prelude::*;

// Emitted on every state change, so clients and indexers can follow a bounty
// without polling its account. The same events as the OpenBounty web program,
// except that EscrowInitialized carries the u64 bounty ID instead of a nonce.

#[event]
pub struct EscrowInitialized {
    pub escrow: Pubkey,
    pub organizer: Pubkey,
    pub bounty_id: u64,
    pub prize_pool: u64,
    pub submissions_deadline: i64,
    pub deadline: i64,
    pub claim_deadline: i64,
}

// Emitted for every vote, including the one that decides a tier.
#[event]
pub struct VoteCast {
    pub escrow: Pubkey,
    pub tier_index: u8,
    pub judge: Pubkey,
    pub candidate: Pubkey,
}

// Emitted after the VoteCast of the vote that brings a candidate to the
// threshold.
#[event]
pub struct TierFinalized {
    pub escrow: Pubkey,
    pub tier_index: u8,
    pub winner: Pubkey,
}

#[event]
pub struct PrizeClaimed {
    pub escrow: Pubkey,
    pub tier_index: u8,
    pub winner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct TierRefunded {
    pub escrow: Pubkey,
    pub tier_index: u8,
    pub amount: u64,
}

// Emitted when the last open tier is settled and the escrow account closes.
#[event]
pub struct EscrowClosed {
    pub escrow: Pubkey,
}

#[event]
pub struct EntrySubmitted {
    pub escrow: Pubkey,
    pub submission: Pubkey,
    pub submitter: Pubkey,
}

#[event]
pub struct EntryClosed {
    pub escrow: Pubkey,
    pub submission: Pubkey,
    pub submitter: Pubkey,
}
