use anchor_lang::prelude::*;

use crate::constants::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct TierVote {
    pub judge: Pubkey,
    pub candidate: Pubkey,
}

// The fixed-size fields come first, so within a tier only `winner` and
// `votes` vary in size.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct PrizeTier {
    pub amount: u64,
    pub claimed: bool,
    // Reserved for the win badge, so adding it later needs no layout change.
    pub badge_minted: bool,
    pub winner: Option<Pubkey>,
    // Each judge votes at most once per tier, so this never holds more
    // than MAX_JUDGES entries.
    #[max_len(MAX_JUDGES)]
    pub votes: Vec<TierVote>,
}

impl PrizeTier {
    pub fn is_finalized(&self) -> bool {
        self.winner.is_some()
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

// One per organizer. It is created with their first bounty and never
// closed, so the counter only ever goes up and a bounty ID is never handed
// out twice. That is what keeps every escrow address unique forever.
#[account]
#[derive(InitSpace)]
pub struct OrganizerProfile {
    pub next_bounty_id: u64,
}

impl OrganizerProfile {
    // The extra 8 bytes hold the account discriminator.
    pub const LEN: usize = 8 + OrganizerProfile::INIT_SPACE;
}

// Clients filter escrows with `memcmp` at fixed byte offsets, so every
// fixed-size field comes before the first string or vector, and none of
// these fields may be moved. `version` is first so any future layout can be
// told apart by one byte at offset 8. `judges` is the first variable-size
// field, which puts each judge slot at a fixed offset as well.
#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub version: u8,             // offset 8
    pub organizer: Pubkey,       // offset 9
    pub bounty_id: u64,          // offset 41
    pub mint: Pubkey,            // offset 49
    pub deadline: i64,           // offset 81, voting closes
    pub claim_deadline: i64,     // offset 89, claiming closes
    pub threshold: u8,           // offset 97
    pub bump: u8,                // offset 98
    pub vault_bump: u8,          // offset 99
    pub metadata_hash: [u8; 32], // offset 100
    #[max_len(MAX_JUDGES)]
    pub judges: Vec<Pubkey>, // offset 132, judge i at 136 + 32 * i
    #[max_len(MAX_TITLE_LEN)]
    pub title: String,
    #[max_len(MAX_METADATA_URI_LEN)]
    pub metadata_uri: String,
    #[max_len(MAX_TIERS)]
    pub tiers: Vec<PrizeTier>,
}

impl Escrow {
    // The extra 8 bytes hold the account discriminator Anchor writes
    // at the start of every account.
    pub const LEN: usize = 8 + Escrow::INIT_SPACE;

    pub fn is_judge(&self, key: &Pubkey) -> bool {
        self.judges.contains(key)
    }

    pub fn all_tiers_claimed(&self) -> bool {
        for tier in &self.tiers {
            if !tier.claimed {
                return false;
            }
        }
        true
    }
}
