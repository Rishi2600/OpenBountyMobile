pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub mod vault;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("3xbu7yrMBpbhtzb5FqJgTydvEtPHBKWoQAQ5Vaw5nMCM");

#[program]
pub mod openbounty {
    use super::*;

    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        title: String,
        metadata_uri: String,
        metadata_hash: [u8; 32],
        judges: Vec<Pubkey>,
        threshold: u8,
        tier_amounts: Vec<u64>,
        deadline: i64,
        claim_deadline: i64,
    ) -> Result<()> {
        instructions::initialize::handle_initialize_escrow(
            ctx,
            title,
            metadata_uri,
            metadata_hash,
            judges,
            threshold,
            tier_amounts,
            deadline,
            claim_deadline,
        )
    }

    // Named cast_vote rather than v1's vote_winner because the name sets the
    // instruction's discriminator. With a new discriminator, a vote encoded
    // for the old instruction is rejected instead of being read with the new
    // argument layout.
    pub fn cast_vote(ctx: Context<CastVote>, tier: u8, candidate: Pubkey) -> Result<()> {
        instructions::vote::handle_cast_vote(ctx, tier, candidate)
    }

    pub fn claim_prize(ctx: Context<ClaimPrize>, tier: u8) -> Result<()> {
        instructions::claim::handle_claim_prize(ctx, tier)
    }

    pub fn refund_unclaimed(ctx: Context<RefundUnclaimed>) -> Result<()> {
        instructions::refund::handle_refund_unclaimed(ctx)
    }

    pub fn mint_win_badge(ctx: Context<MintWinBadge>, tier: u8) -> Result<()> {
        instructions::badge::handle_mint_win_badge(ctx, tier)
    }
}
