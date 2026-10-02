use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::{Escrow, TierVote};

#[derive(Accounts)]
pub struct VoteWinner<'info> {
    // The seeds are read from the escrow's own data, so a judge passes only
    // the escrow's address. Bounty IDs are never reused, so that address names
    // exactly one bounty forever, and a vote built for a closed bounty can
    // never land on a newer one.
    #[account(
        mut,
        seeds = [
            ESCROW_SEED,
            escrow.organizer.as_ref(),
            &escrow.bounty_id.to_le_bytes()
        ],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,

    pub judge: Signer<'info>,
}

pub fn handle_vote_winner(ctx: Context<VoteWinner>, tier: u8, candidate: Pubkey) -> Result<()> {
    let judge = ctx.accounts.judge.key();
    let escrow = &mut ctx.accounts.escrow;

    // Checked before anything else is read, so an account written with a
    // different layout is rejected instead of being misread.
    require!(
        escrow.version == ESCROW_VERSION,
        ErrorCode::UnsupportedEscrowVersion
    );

    require!(escrow.is_judge(&judge), ErrorCode::NotAJudge);

    let now = Clock::get()?.unix_timestamp;
    require!(now <= escrow.deadline, ErrorCode::DeadlinePassed);

    let tier_index = tier as usize;
    require!(tier_index < escrow.tiers.len(), ErrorCode::InvalidTierIndex);

    // Read before borrowing the tier mutably, because that borrow holds the
    // whole escrow until the end of the function.
    let threshold = escrow.threshold as usize;

    let prize_tier = &mut escrow.tiers[tier_index];
    require!(!prize_tier.is_finalized(), ErrorCode::TierAlreadyFinalized);
    require!(!prize_tier.has_voted(&judge), ErrorCode::AlreadyVoted);

    prize_tier.votes.push(TierVote { judge, candidate });

    // The vote that brings a candidate to the threshold finalizes the tier
    // right away, so there is no separate finalize instruction. Once `winner`
    // is set, the checks above reject any further votes on this tier.
    if prize_tier.count_votes_for(&candidate) >= threshold {
        prize_tier.winner = Some(candidate);
    }

    Ok(())
}
