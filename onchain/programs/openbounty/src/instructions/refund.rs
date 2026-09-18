use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::Escrow;
use crate::vault::transfer_from_vault;

#[derive(Accounts)]
#[instruction(nonce: u8)]
pub struct RefundUnclaimed<'info> {
    // The seeds use the organizer key stored in the escrow, not the signer's
    // key. Anchor checks seeds before `has_one`, so this way a wrong signer
    // reaches `has_one` and gets the readable `Unauthorized` error instead of
    // Anchor's generic seeds error.
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.organizer.as_ref(), &[nonce]],
        bump = escrow.bump,
        has_one = organizer @ ErrorCode::Unauthorized
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.organizer.as_ref(), &[nonce]],
        bump = escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub organizer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_refund_unclaimed(ctx: Context<RefundUnclaimed>, nonce: u8) -> Result<()> {
    let organizer = ctx.accounts.escrow.organizer;
    let vault_bump = ctx.accounts.escrow.vault_bump;

    let now = Clock::get()?.unix_timestamp;
    require!(
        now > ctx.accounts.escrow.deadline,
        ErrorCode::DeadlineNotPassed
    );

    // Covers both tiers that never got a winner and tiers whose winner never
    // claimed.
    let unclaimed_total = sum_unclaimed(&ctx.accounts.escrow)?;
    require!(unclaimed_total > 0, ErrorCode::NoUnclaimedFunds);

    // Mark every tier claimed before any lamports move, so nothing in this
    // escrow can be refunded twice or claimed afterwards.
    for tier in ctx.accounts.escrow.tiers.iter_mut() {
        tier.claimed = true;
    }

    // The vault holds the unclaimed prizes plus its own rent-exempt minimum
    // (plus any lamports someone sent it directly), so moving its whole
    // balance refunds the prizes and returns the vault's rent in one
    // transfer. The vault ends at zero and the runtime removes it.
    let vault_balance = ctx.accounts.vault.lamports();
    transfer_from_vault(
        &ctx.accounts.vault,
        ctx.accounts.organizer.to_account_info(),
        organizer,
        nonce,
        vault_bump,
        vault_balance,
    )?;

    // Done last: this moves the escrow's rent to the organizer and wipes its
    // data, so the escrow must not be read or written after this.
    ctx.accounts
        .escrow
        .close(ctx.accounts.organizer.to_account_info())?;

    Ok(())
}

fn sum_unclaimed(escrow: &Escrow) -> Result<u64> {
    let mut total: u64 = 0;
    for tier in &escrow.tiers {
        if !tier.claimed {
            total = total
                .checked_add(tier.amount)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
        }
    }
    Ok(total)
}
