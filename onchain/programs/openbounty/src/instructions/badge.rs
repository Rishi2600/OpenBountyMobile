use anchor_lang::prelude::*;
use mpl_core::instructions::CreateV2CpiBuilder;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::Escrow;

#[derive(Accounts)]
#[instruction(tier: u8)]
pub struct MintWinBadge<'info> {
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

    // Signs as the payer of the new badge and becomes its owner.
    #[account(mut)]
    pub winner: Signer<'info>,

    /// CHECK: The address where Metaplex Core creates the badge. The seeds tie
    /// it to this escrow and tier, so each tier has exactly one possible badge
    /// address. Core creates the account and fails if anything is already
    /// there.
    #[account(
        mut,
        seeds = [BADGE_SEED, escrow.key().as_ref(), &[tier]],
        bump
    )]
    pub badge: UncheckedAccount<'info>,

    /// CHECK: Holds no data and never signs. It is only recorded as the
    /// update authority of every badge, and no instruction acts on its behalf,
    /// so badges cannot be edited.
    #[account(seeds = [BADGE_AUTHORITY_SEED], bump)]
    pub badge_authority: UncheckedAccount<'info>,

    /// CHECK: Must be the Metaplex Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_mint_win_badge(ctx: Context<MintWinBadge>, tier: u8) -> Result<()> {
    let claimant = ctx.accounts.winner.key();
    let escrow_key = ctx.accounts.escrow.key();
    let escrow = &mut ctx.accounts.escrow;

    // Checked before anything else is read, so an account written with a
    // different layout is rejected instead of being misread.
    require!(
        escrow.version == ESCROW_VERSION,
        ErrorCode::UnsupportedEscrowVersion
    );

    let tier_index = tier as usize;
    require!(tier_index < escrow.tiers.len(), ErrorCode::InvalidTierIndex);

    // Read before borrowing the tier mutably, because that borrow holds the
    // whole escrow until the end of the function.
    let badge_name = format!("OpenBounty: {} #{}", escrow.title, tier_index + 1);

    // A badge is only for a decided, still unclaimed tier. The final claim
    // closes the escrow, so the client mints the badge before the claim, in
    // the same transaction.
    let prize_tier = &mut escrow.tiers[tier_index];
    require!(prize_tier.is_finalized(), ErrorCode::TierNotFinalized);
    require!(!prize_tier.claimed, ErrorCode::TierAlreadyClaimed);
    require!(prize_tier.winner == Some(claimant), ErrorCode::NotWinner);
    require!(!prize_tier.badge_minted, ErrorCode::BadgeAlreadyMinted);

    prize_tier.badge_minted = true;

    // The badge account is created at an address only this program can sign
    // for, so the program supplies the badge's seeds as its signature.
    let tier_bytes = [tier];
    let bump_bytes = [ctx.bumps.badge];
    let badge_seeds: &[&[u8]] = &[BADGE_SEED, escrow_key.as_ref(), &tier_bytes, &bump_bytes];
    let signer_seeds: &[&[&[u8]]] = &[badge_seeds];

    let core_program = ctx.accounts.mpl_core_program.to_account_info();
    let badge = ctx.accounts.badge.to_account_info();
    let winner = ctx.accounts.winner.to_account_info();
    let badge_authority = ctx.accounts.badge_authority.to_account_info();
    let system_program = ctx.accounts.system_program.to_account_info();

    let mut create_badge = CreateV2CpiBuilder::new(&core_program);
    create_badge.asset(&badge);
    create_badge.payer(&winner);
    create_badge.owner(Some(&winner));
    create_badge.update_authority(Some(&badge_authority));
    create_badge.system_program(&system_program);
    create_badge.name(badge_name);
    create_badge.uri(BADGE_URI.to_string());
    create_badge.invoke_signed(signer_seeds)?;

    Ok(())
}
