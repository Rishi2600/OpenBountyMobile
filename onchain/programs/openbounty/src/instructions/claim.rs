use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::OpenBountyError;
use crate::events::PrizeClaimed;
use crate::state::Escrow;
use crate::vault::{close_if_settled, pay_from_vault};

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    // Must be the tier's winner. Receives the prize.
    #[account(mut)]
    pub winner: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.organizer.as_ref(), &escrow.bounty_id.to_le_bytes()],
        bump = escrow.bump,
        has_one = organizer @ OpenBountyError::OrganizerMismatch
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.organizer.as_ref(), &escrow.bounty_id.to_le_bytes()],
        bump = escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    // Not a signer. Receives the escrow's rent, and anything left in the
    // vault, when this claim settles the last open tier. Its owner is
    // deliberately not checked: a wallet can reassign itself to another
    // program, and an owner check would let the organizer block every claim
    // that way and then refund the prizes after the claim window.
    /// CHECK: `has_one` on the escrow pins the address, and it is only credited.
    #[account(mut)]
    pub organizer: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_claim_prize(ctx: Context<ClaimPrize>, tier_index: u8) -> Result<()> {
    let winner = ctx.accounts.winner.key();
    let escrow_key = ctx.accounts.escrow.key();
    let now = Clock::get()?.unix_timestamp;

    let escrow = &mut ctx.accounts.escrow;
    let claim_deadline = escrow.claim_deadline;
    let tier = escrow
        .prize_tiers
        .get_mut(tier_index as usize)
        .ok_or(OpenBountyError::InvalidTier)?;
    let tier_winner = tier.winner.ok_or(OpenBountyError::TierNotFinalized)?;
    require!(tier_winner == winner, OpenBountyError::NotWinner);
    require!(!tier.claimed, OpenBountyError::PrizeAlreadyClaimed);
    // A winner's prize is theirs until the claim window ends, even before the
    // deadline. A refunded winner tier means the window has already closed.
    require!(
        now <= claim_deadline && !tier.refunded,
        OpenBountyError::ClaimWindowClosed
    );

    tier.claimed = true;
    let amount = tier.amount;

    pay_from_vault(
        &ctx.accounts.escrow,
        &ctx.accounts.vault,
        ctx.accounts.winner.to_account_info(),
        &ctx.accounts.system_program,
        amount,
    )?;
    emit!(PrizeClaimed {
        escrow: escrow_key,
        tier_index,
        winner,
        amount,
    });

    close_if_settled(
        &mut ctx.accounts.escrow,
        &ctx.accounts.vault,
        ctx.accounts.organizer.to_account_info(),
        &ctx.accounts.system_program,
    )
}
