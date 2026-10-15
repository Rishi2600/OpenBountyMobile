use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::OpenBountyError;
use crate::events::TierRefunded;
use crate::state::Escrow;
use crate::vault::{close_if_settled, pay_from_vault};

#[derive(Accounts)]
pub struct RefundUnclaimed<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.organizer.as_ref(), &escrow.bounty_id.to_le_bytes()],
        bump = escrow.bump,
        has_one = organizer @ OpenBountyError::UnauthorizedOrganizer
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.organizer.as_ref(), &escrow.bounty_id.to_le_bytes()],
        bump = escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

// There is no emergency or admin withdrawal: this is the organizer's only way
// to get funds back. Each call refunds one tier; refunding several tiers takes
// one instruction per tier, and they fit in a single transaction.
pub fn handle_refund_unclaimed(ctx: Context<RefundUnclaimed>, tier_index: u8) -> Result<()> {
    let escrow_key = ctx.accounts.escrow.key();
    let now = Clock::get()?.unix_timestamp;

    let escrow = &mut ctx.accounts.escrow;
    let deadline = escrow.deadline;
    let claim_deadline = escrow.claim_deadline;
    let tier = escrow
        .prize_tiers
        .get_mut(tier_index as usize)
        .ok_or(OpenBountyError::InvalidTier)?;
    require!(!tier.is_settled(), OpenBountyError::RefundNotEligible);

    // Never before the deadline. A tier with a winner stays the winner's until
    // the claim window closes.
    require!(now > deadline, OpenBountyError::DeadlineNotReached);
    if tier.winner.is_some() {
        require!(now > claim_deadline, OpenBountyError::ClaimWindowOpen);
    }

    tier.refunded = true;
    let amount = tier.amount;

    pay_from_vault(
        &ctx.accounts.escrow,
        &ctx.accounts.vault,
        ctx.accounts.organizer.to_account_info(),
        &ctx.accounts.system_program,
        amount,
    )?;
    emit!(TierRefunded {
        escrow: escrow_key,
        tier_index,
        amount,
    });

    close_if_settled(
        &mut ctx.accounts.escrow,
        &ctx.accounts.vault,
        ctx.accounts.organizer.to_account_info(),
        &ctx.accounts.system_program,
    )
}
