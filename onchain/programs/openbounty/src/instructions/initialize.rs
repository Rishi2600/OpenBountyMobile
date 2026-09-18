use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::{Escrow, PrizeTier};

#[derive(Accounts)]
#[instruction(
    title: String,
    metadata_uri: String,
    judges: Vec<Pubkey>,
    threshold: u8,
    tier_amounts: Vec<u64>,
    deadline: i64,
    nonce: u8
)]
pub struct InitializeEscrow<'info> {
    #[account(
        init,
        payer = organizer,
        space = Escrow::LEN,
        seeds = [ESCROW_SEED, organizer.key().as_ref(), &[nonce]],
        bump
    )]
    pub escrow: Account<'info, Escrow>,

    // The vault holds no data. It is created by the transfer of the prize
    // pool in the handler, so there is no `init` here.
    #[account(
        mut,
        seeds = [VAULT_SEED, organizer.key().as_ref(), &[nonce]],
        bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub organizer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_escrow(
    ctx: Context<InitializeEscrow>,
    title: String,
    metadata_uri: String,
    judges: Vec<Pubkey>,
    threshold: u8,
    tier_amounts: Vec<u64>,
    deadline: i64,
    nonce: u8,
) -> Result<()> {
    require!(!title.is_empty(), ErrorCode::InvalidTitleLength);
    require!(title.len() <= MAX_TITLE_LEN, ErrorCode::InvalidTitleLength);
    require!(
        metadata_uri.len() <= MAX_METADATA_URI_LEN,
        ErrorCode::InvalidMetadataUriLength
    );

    require!(!judges.is_empty(), ErrorCode::NoJudges);
    require!(judges.len() <= MAX_JUDGES, ErrorCode::TooManyJudges);

    require!(!tier_amounts.is_empty(), ErrorCode::NoTiers);
    require!(tier_amounts.len() <= MAX_TIERS, ErrorCode::TooManyTiers);

    require!(threshold > 0, ErrorCode::InvalidThreshold);
    require!(
        (threshold as usize) <= judges.len(),
        ErrorCode::InvalidThreshold
    );

    let now = Clock::get()?.unix_timestamp;
    require!(deadline > now, ErrorCode::InvalidDeadline);

    let prize_total = sum_tier_amounts(&tier_amounts)?;

    let organizer = ctx.accounts.organizer.key();
    let escrow = &mut ctx.accounts.escrow;
    escrow.organizer = organizer;
    escrow.title = title;
    escrow.metadata_uri = metadata_uri;
    escrow.judges = judges;
    escrow.tiers = build_tiers(&tier_amounts);
    escrow.deadline = deadline;
    escrow.threshold = threshold;
    escrow.nonce = nonce;
    escrow.bump = ctx.bumps.escrow;
    escrow.vault_bump = ctx.bumps.vault;

    // A system account with no data still has to hold the rent-exempt
    // minimum, or the runtime can remove it. That minimum is deposited on
    // top of the prize pool and stays in the vault through every claim,
    // so the vault survives until it is emptied at the final close.
    let vault_rent = Rent::get()?.minimum_balance(0);
    let deposit = prize_total
        .checked_add(vault_rent)
        .ok_or(ErrorCode::ArithmeticOverflow)?;

    let transfer_accounts = system_program::Transfer {
        from: ctx.accounts.organizer.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
    };
    let transfer_context = CpiContext::new(system_program::ID, transfer_accounts);
    system_program::transfer(transfer_context, deposit)?;

    Ok(())
}

// Every tier must hold a positive amount. A zero-amount tier left
// unclaimed would make the refund total zero, and the refund would then
// be rejected, leaving the escrow and vault rent stuck forever.
fn sum_tier_amounts(tier_amounts: &[u64]) -> Result<u64> {
    let mut total: u64 = 0;
    for amount in tier_amounts {
        require!(*amount > 0, ErrorCode::InvalidAmount);
        total = total
            .checked_add(*amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
    }
    Ok(total)
}

fn build_tiers(tier_amounts: &[u64]) -> Vec<PrizeTier> {
    let mut tiers = Vec::new();
    for amount in tier_amounts {
        tiers.push(PrizeTier {
            amount: *amount,
            winner: None,
            claimed: false,
            votes: Vec::new(),
        });
    }
    tiers
}
