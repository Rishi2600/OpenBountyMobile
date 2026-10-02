use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::Escrow;
use crate::vault::{close_vault, transfer_from_vault};

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(
        mut,
        seeds = [
            ESCROW_SEED,
            escrow.organizer.as_ref(),
            &escrow.bounty_id.to_le_bytes()
        ],
        bump = escrow.bump,
        has_one = organizer @ ErrorCode::Unauthorized,
        has_one = mint
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.vault_bump,
        token::mint = mint,
        token::authority = escrow,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub winner: Signer<'info>,

    // Always the winner's own associated token account, created here and paid
    // for by the winner if they do not have one yet, so a prize can never be
    // paid into an account someone else controls.
    #[account(
        init_if_needed,
        payer = winner,
        associated_token::mint = mint,
        associated_token::authority = winner,
        associated_token::token_program = token_program
    )]
    pub winner_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Only receives the rent when the vault and escrow close. The
    /// `has_one = organizer` constraint on `escrow` guarantees this is the
    /// bounty's organizer, so a winner cannot redirect that rent to themselves.
    #[account(mut)]
    pub organizer: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    pub associated_token_program: Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,
}

pub fn handle_claim_prize(ctx: Context<ClaimPrize>, tier: u8) -> Result<()> {
    let claimant = ctx.accounts.winner.key();
    let escrow = &mut ctx.accounts.escrow;

    // Checked before anything else is read, so an account written with a
    // different layout is rejected instead of being misread.
    require!(
        escrow.version == ESCROW_VERSION,
        ErrorCode::UnsupportedEscrowVersion
    );

    // A winner can claim before or after voting closes, but only until the
    // claim deadline. After it, the organizer may refund the tier instead.
    let now = Clock::get()?.unix_timestamp;
    require!(now <= escrow.claim_deadline, ErrorCode::ClaimDeadlinePassed);

    let tier_index = tier as usize;
    require!(tier_index < escrow.tiers.len(), ErrorCode::InvalidTierIndex);

    let prize_tier = &mut escrow.tiers[tier_index];
    require!(prize_tier.is_finalized(), ErrorCode::TierNotFinalized);
    require!(!prize_tier.claimed, ErrorCode::TierAlreadyClaimed);
    require!(prize_tier.winner == Some(claimant), ErrorCode::NotWinner);

    // Marked before any tokens move, the same order refund uses. The
    // transaction is atomic, so if the transfer fails this flag is rolled
    // back with it.
    let amount = prize_tier.amount;
    prize_tier.claimed = true;

    let is_final_claim = escrow.all_tiers_claimed();

    // On the final claim the winner also receives anything else in the vault,
    // such as tokens someone sent to it directly. The token program only
    // closes an empty account, so leaving them would stop the bounty closing.
    // `vault.amount` was read before this instruction moved anything, so it
    // is the vault's whole balance.
    let mut payout = amount;
    if is_final_claim {
        payout = ctx.accounts.vault.amount;
    }

    transfer_from_vault(
        &ctx.accounts.vault,
        &ctx.accounts.mint,
        &ctx.accounts.winner_token_account,
        &ctx.accounts.escrow,
        &ctx.accounts.token_program,
        payout,
    )?;

    // Anchor's `close` constraint would close on every claim, but the accounts
    // may only close once every tier is paid out, so the close is done here by
    // hand.
    if !is_final_claim {
        return Ok(());
    }

    close_vault(
        &ctx.accounts.vault,
        ctx.accounts.organizer.to_account_info(),
        &ctx.accounts.escrow,
        &ctx.accounts.token_program,
    )?;

    // Done last: this moves the escrow's rent to the organizer and wipes its
    // data, so the escrow must not be read or written after this.
    ctx.accounts
        .escrow
        .close(ctx.accounts.organizer.to_account_info())?;

    Ok(())
}
