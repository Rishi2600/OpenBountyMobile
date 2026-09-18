use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::Escrow;
use crate::vault::transfer_from_vault;

#[derive(Accounts)]
#[instruction(nonce: u8)]
pub struct ClaimPrize<'info> {
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
    pub winner: Signer<'info>,

    /// CHECK: Only receives the rent when the escrow and vault close. The
    /// `has_one = organizer` constraint on `escrow` guarantees this is the
    /// bounty's organizer, so a winner cannot redirect that rent to themselves.
    #[account(mut)]
    pub organizer: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_claim_prize(ctx: Context<ClaimPrize>, nonce: u8, tier: u8) -> Result<()> {
    let claimant = ctx.accounts.winner.key();

    // Copy what the vault transfer needs before borrowing the tier mutably.
    let organizer = ctx.accounts.escrow.organizer;
    let vault_bump = ctx.accounts.escrow.vault_bump;

    let escrow = &mut ctx.accounts.escrow;
    let tier_index = tier as usize;
    require!(tier_index < escrow.tiers.len(), ErrorCode::InvalidTierIndex);

    let prize_tier = &mut escrow.tiers[tier_index];
    require!(prize_tier.is_finalized(), ErrorCode::TierNotFinalized);
    require!(!prize_tier.claimed, ErrorCode::TierAlreadyClaimed);
    require!(prize_tier.winner == Some(claimant), ErrorCode::NotWinner);

    // Marked before the transfer, the same order refund uses. The transaction
    // is atomic, so if the transfer fails this flag is rolled back with it.
    let amount = prize_tier.amount;
    prize_tier.claimed = true;

    transfer_from_vault(
        &ctx.accounts.vault,
        ctx.accounts.winner.to_account_info(),
        organizer,
        nonce,
        vault_bump,
        amount,
    )?;

    // Anchor's `close` constraint would close on every claim, but the accounts
    // may only close once every tier is paid out, so the close is done here by
    // hand. Nothing is left to refund at that point.
    if ctx.accounts.escrow.all_tiers_claimed() {
        // What remains in the vault is its rent-exempt minimum plus any
        // lamports someone sent it directly. Moving all of it leaves the vault
        // at zero, and the runtime removes it at the end of the transaction.
        let remaining = ctx.accounts.vault.lamports();
        transfer_from_vault(
            &ctx.accounts.vault,
            ctx.accounts.organizer.to_account_info(),
            organizer,
            nonce,
            vault_bump,
            remaining,
        )?;

        // Done last: this moves the escrow's rent to the organizer and wipes
        // its data, so the escrow must not be read or written after this.
        ctx.accounts
            .escrow
            .close(ctx.accounts.organizer.to_account_info())?;
    }

    Ok(())
}
