use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::error::ErrorCode;
use crate::events::BountyRefunded;
use crate::state::Escrow;
use crate::vault::{close_vault, transfer_from_vault};

#[derive(Accounts)]
pub struct RefundUnclaimed<'info> {
    // The seeds use the organizer key stored in the escrow, not the signer's
    // key. Anchor checks seeds before `has_one`, so this way a wrong signer
    // reaches `has_one` and gets the readable `Unauthorized` error instead of
    // Anchor's generic seeds error.
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
    pub organizer: Signer<'info>,

    // Always the organizer's own associated token account, created here and
    // paid for by the organizer if they closed the one they deposited from.
    #[account(
        init_if_needed,
        payer = organizer,
        associated_token::mint = mint,
        associated_token::authority = organizer,
        associated_token::token_program = token_program
    )]
    pub organizer_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,

    pub associated_token_program: Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,
}

pub fn handle_refund_unclaimed(ctx: Context<RefundUnclaimed>) -> Result<()> {
    let escrow_key = ctx.accounts.escrow.key();
    let bounty_id = ctx.accounts.escrow.bounty_id;
    let organizer = ctx.accounts.organizer.key();
    let escrow = &mut ctx.accounts.escrow;

    // Checked before anything else is read, so an account written with a
    // different layout is rejected instead of being misread.
    require!(
        escrow.version == ESCROW_VERSION,
        ErrorCode::UnsupportedEscrowVersion
    );

    // Only after the claim deadline, so every winner has had the whole claim
    // window to collect their prize first.
    let now = Clock::get()?.unix_timestamp;
    require!(now > escrow.claim_deadline, ErrorCode::DeadlineNotPassed);

    // Covers both tiers that never got a winner and tiers whose winner never
    // claimed.
    let unclaimed_total = sum_unclaimed(escrow)?;
    require!(unclaimed_total > 0, ErrorCode::NoUnclaimedFunds);

    // Mark every tier claimed before any tokens move, so nothing in this
    // escrow can be refunded twice or claimed afterwards.
    for tier in escrow.tiers.iter_mut() {
        tier.claimed = true;
    }

    // The vault holds the unclaimed prizes, plus any tokens someone sent to it
    // directly. Moving its whole balance empties it, which the token program
    // requires before it will close the account. `vault.amount` was read
    // before this instruction moved anything.
    let vault_balance = ctx.accounts.vault.amount;
    transfer_from_vault(
        &ctx.accounts.vault,
        &ctx.accounts.mint,
        &ctx.accounts.organizer_token_account,
        &ctx.accounts.escrow,
        &ctx.accounts.token_program,
        vault_balance,
    )?;

    emit!(BountyRefunded {
        escrow: escrow_key,
        bounty_id,
        organizer,
        amount: vault_balance,
    });

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
