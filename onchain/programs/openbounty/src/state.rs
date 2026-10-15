use anchor_lang::prelude::*;

use crate::constants::*;

// One per organizer. It is created with their first bounty and never closed,
// so the counter only ever goes up and a bounty ID is never handed out twice.
// That keeps every escrow address unique forever. Its layout is unchanged
// from v2, so profiles already on devnet stay valid.
#[account]
#[derive(InitSpace)]
pub struct OrganizerProfile {
    pub next_bounty_id: u64,
}

impl OrganizerProfile {
    // The extra 8 bytes hold the account discriminator.
    pub const LEN: usize = 8 + OrganizerProfile::INIT_SPACE;
}

// A funded bounty. An escrow only ever exists fully funded: it is created in
// the same instruction that moves the whole prize pool into the vault.
//
// No role is stored as a flag. The organizer is `organizer`, a judge is any
// key in `judges`, and a winner is `prize_tiers[i].winner` once set.
//
// Fixed-size fields come first, so clients can filter with `memcmp` at fixed
// offsets: `organizer` at 8 and `bounty_id` at 40.
#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub organizer: Pubkey,
    pub bounty_id: u64,
    pub bump: u8,
    pub vault_bump: u8,
    // Votes for the same candidate on a tier needed to decide it.
    pub vote_threshold: u8,
    pub created_at: i64,
    // Entries are accepted until this time (inclusive). Never after
    // `deadline`.
    pub submissions_deadline: i64,
    // Judges vote until this time (inclusive). After it, tiers that never got
    // a winner can be refunded.
    pub deadline: i64,
    // Winners claim until this time (inclusive): `deadline` plus the
    // organizer's claim window. After it, unclaimed prizes can be refunded.
    pub claim_deadline: i64,
    #[max_len(MAX_TITLE_LENGTH)]
    pub title: String,
    #[max_len(MAX_METADATA_URI_LENGTH)]
    pub metadata_uri: String,
    #[max_len(MAX_JUDGES)]
    pub judges: Vec<Pubkey>,
    #[max_len(MAX_PRIZE_TIERS)]
    pub prize_tiers: Vec<PrizeTier>,
}

impl Escrow {
    // The extra 8 bytes hold the account discriminator.
    pub const LEN: usize = 8 + Escrow::INIT_SPACE;

    pub fn is_judge(&self, key: &Pubkey) -> bool {
        self.judges.contains(key)
    }

    // True once every tier is claimed or refunded. The escrow then closes.
    pub fn is_settled(&self) -> bool {
        for tier in &self.prize_tiers {
            if !tier.is_settled() {
                return false;
            }
        }
        true
    }
}

// Clients decode escrows at the offsets above, and `init` allocates through a
// system program call that is capped at 10 KiB. Changing a field or a limit
// fails the build here instead of silently moving the layout.
const _: () = assert!(Escrow::LEN == 1877);

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct PrizeTier {
    // Lamports paid to this tier's winner.
    pub amount: u64,
    // Set by the program when a candidate reaches `vote_threshold`.
    pub winner: Option<Pubkey>,
    pub claimed: bool,
    // Set when the organizer takes this tier's amount back.
    pub refunded: bool,
    // Each judge votes at most once per tier, so this never holds more than
    // MAX_JUDGES entries.
    #[max_len(MAX_JUDGES)]
    pub votes: Vec<Vote>,
}

impl PrizeTier {
    pub fn is_settled(&self) -> bool {
        self.claimed || self.refunded
    }

    pub fn has_voted(&self, judge: &Pubkey) -> bool {
        for vote in &self.votes {
            if vote.judge == *judge {
                return true;
            }
        }
        false
    }

    pub fn count_votes_for(&self, candidate: &Pubkey) -> usize {
        let mut count = 0;
        for vote in &self.votes {
            if vote.candidate == *candidate {
                count += 1;
            }
        }
        count
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Vote {
    pub judge: Pubkey,
    pub candidate: Pubkey,
}

// A builder's entry to a bounty, one per wallet per bounty.
//
// Votes still name wallets, not entries: an entry shows judges what a
// candidate built, but a wallet can be voted for without one.
//
// `escrow` comes first (offset 8), so clients list one bounty's entries with a
// single `memcmp` filter.
#[account]
#[derive(InitSpace)]
pub struct Submission {
    pub escrow: Pubkey,
    // Pays the rent and gets it back through close_entry.
    pub submitter: Pubkey,
    pub submitted_at: i64,
    // The bounty's deadline, copied at submission so the entry can still be
    // closed after the escrow account itself has closed.
    pub close_after: i64,
    pub bump: u8,
    #[max_len(MAX_ENTRY_TITLE_LENGTH)]
    pub title: String,
    #[max_len(MAX_ENTRY_URL_LENGTH)]
    pub url: String,
    #[max_len(MAX_ENTRY_DESCRIPTION_LENGTH)]
    pub description: String,
}

impl Submission {
    // The extra 8 bytes hold the account discriminator.
    pub const LEN: usize = 8 + Submission::INIT_SPACE;
}

const _: () = assert!(Submission::LEN == 531);
