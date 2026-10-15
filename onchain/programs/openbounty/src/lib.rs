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

// OpenBounty: trustless escrow for bounty prizes, matching the OpenBounty web
// program. Entry points only dispatch; validation and logic live in
// `instructions/`.
#[program]
pub mod openbounty {
    use super::*;

    // Creates a bounty and funds its whole prize pool in one transaction.
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        params: InitializeEscrowParams,
    ) -> Result<()> {
        instructions::initialize::handle_initialize_escrow(ctx, params)
    }

    // A judge votes for a candidate on one prize tier. The tier is decided
    // when a candidate reaches the vote threshold.
    pub fn vote_winner(ctx: Context<VoteWinner>, tier_index: u8, candidate: Pubkey) -> Result<()> {
        instructions::vote::handle_vote_winner(ctx, tier_index, candidate)
    }

    // The winner of a decided tier claims its prize, until the claim window
    // ends.
    pub fn claim_prize(ctx: Context<ClaimPrize>, tier_index: u8) -> Result<()> {
        instructions::claim::handle_claim_prize(ctx, tier_index)
    }

    // The organizer takes back a tier that never got a winner (after the
    // deadline) or whose winner did not claim (after the claim window).
    pub fn refund_unclaimed(ctx: Context<RefundUnclaimed>, tier_index: u8) -> Result<()> {
        instructions::refund::handle_refund_unclaimed(ctx, tier_index)
    }

    // A builder enters a bounty before its entries close.
    pub fn submit_entry(
        ctx: Context<SubmitEntry>,
        title: String,
        url: String,
        description: String,
    ) -> Result<()> {
        instructions::submit_entry::handle_submit_entry(ctx, title, url, description)
    }

    // After the deadline, a builder closes their entry and gets its rent back.
    pub fn close_entry(ctx: Context<CloseEntry>) -> Result<()> {
        instructions::close_entry::handle_close_entry(ctx)
    }
}
