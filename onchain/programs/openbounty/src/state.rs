use anchor_lang::prelude::*;

use crate::constants::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct TierVote {
    pub judge: Pubkey,
    pub candidate: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct PrizeTier {
    pub amount: u64,
    pub winner: Option<Pubkey>,
    pub claimed: bool,
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

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub organizer: Pubkey,
    #[max_len(MAX_TITLE_LEN)]
    pub title: String,
    #[max_len(MAX_METADATA_URI_LEN)]
    pub metadata_uri: String,
    #[max_len(MAX_JUDGES)]
    pub judges: Vec<Pubkey>,
    #[max_len(MAX_TIERS)]
    pub tiers: Vec<PrizeTier>,
    pub deadline: i64,
    pub threshold: u8,
    pub nonce: u8,
    pub bump: u8,
    pub vault_bump: u8,
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
