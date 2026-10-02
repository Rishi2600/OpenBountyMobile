use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::ErrorCode;
use crate::events::BountyCreated;
use crate::state::{Escrow, OrganizerProfile, PrizeTier};

#[derive(Accounts)]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,

    // Created with the organizer's first bounty. On later bounties it already
    // exists and only its counter changes.
    #[account(
        init_if_needed,
        payer = organizer,
        space = OrganizerProfile::LEN,
        seeds = [ORGANIZER_SEED, organizer.key().as_ref()],
        bump
    )]
    pub organizer_profile: Account<'info, OrganizerProfile>,

    // The bounty ID in the seeds comes from the profile's counter, never from
    // an argument, so an ID can never be used twice. If two creates from one
    // wallet race, both pass the same address; the second one finds the
    // counter already moved on and fails this seeds check.
    #[account(
        init,
        payer = organizer,
        space = Escrow::LEN,
        seeds = [
            ESCROW_SEED,
            organizer.key().as_ref(),
            &organizer_profile.next_bounty_id.to_le_bytes()
        ],
        bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,

    // A token account at a PDA of this program rather than an associated token
    // account. Nobody else can create an account at this address first, so a
    // bounty can never be blocked by someone squatting on its vault address.
    #[account(
        init,
        payer = organizer,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = organizer,
        token::token_program = token_program
    )]
    pub organizer_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_escrow(
    ctx: Context<InitializeEscrow>,
    title: String,
    metadata_uri: String,
    metadata_hash: [u8; 32],
    judges: Vec<Pubkey>,
    threshold: u8,
    tier_amounts: Vec<u64>,
    deadline: i64,
    claim_deadline: i64,
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

    let organizer = ctx.accounts.organizer.key();
    require_organizer_not_judge(&judges, &organizer)?;
    require_no_duplicate_judges(&judges)?;

    let now = Clock::get()?.unix_timestamp;
    require!(deadline > now, ErrorCode::InvalidDeadline);
    require_claim_window(deadline, claim_deadline)?;

    let prize_total = sum_tier_amounts(&tier_amounts)?;

    require_supported_mint(&ctx.accounts.mint)?;

    // This bounty takes the ID its address was derived from, and the counter
    // moves on so the next bounty gets a new address.
    let profile = &mut ctx.accounts.organizer_profile;
    let bounty_id = profile.next_bounty_id;
    profile.next_bounty_id = bounty_id
        .checked_add(1)
        .ok_or(ErrorCode::ArithmeticOverflow)?;

    let mint = ctx.accounts.mint.key();
    let escrow = &mut ctx.accounts.escrow;
    escrow.version = ESCROW_VERSION;
    escrow.organizer = organizer;
    escrow.bounty_id = bounty_id;
    escrow.mint = mint;
    escrow.deadline = deadline;
    escrow.claim_deadline = claim_deadline;
    escrow.threshold = threshold;
    escrow.bump = ctx.bumps.escrow;
    escrow.vault_bump = ctx.bumps.vault;
    escrow.metadata_hash = metadata_hash;
    escrow.judges = judges;
    escrow.title = title;
    escrow.metadata_uri = metadata_uri;
    escrow.tiers = build_tiers(&tier_amounts);

    deposit_prize_pool(ctx.accounts, prize_total)?;

    emit!(BountyCreated {
        escrow: ctx.accounts.escrow.key(),
        bounty_id,
        organizer,
        mint,
        prize_total,
    });

    Ok(())
}

fn require_organizer_not_judge(judges: &[Pubkey], organizer: &Pubkey) -> Result<()> {
    for judge in judges {
        require!(judge != organizer, ErrorCode::OrganizerCannotJudge);
    }
    Ok(())
}

// A judge listed twice can still vote only once, so with a high threshold a
// tier could never be decided.
fn require_no_duplicate_judges(judges: &[Pubkey]) -> Result<()> {
    for i in 0..judges.len() {
        for j in (i + 1)..judges.len() {
            require!(judges[i] != judges[j], ErrorCode::DuplicateJudge);
        }
    }
    Ok(())
}

// Winners always get at least MIN_CLAIM_WINDOW after voting closes. A deadline
// so large that adding the window overflows leaves no valid claim deadline,
// so it gets the same error.
fn require_claim_window(deadline: i64, claim_deadline: i64) -> Result<()> {
    let earliest_claim_deadline = deadline
        .checked_add(MIN_CLAIM_WINDOW)
        .ok_or(ErrorCode::InvalidClaimDeadline)?;
    require!(
        claim_deadline >= earliest_claim_deadline,
        ErrorCode::InvalidClaimDeadline
    );
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

// Some Token-2022 extensions let someone other than this program move, tax or
// block the tokens held in the vault. Classic SPL mints cannot carry
// extensions, so only Token-2022 mints are inspected.
fn require_supported_mint(mint: &InterfaceAccount<Mint>) -> Result<()> {
    let mint_info = mint.to_account_info();
    if *mint_info.owner != spl_token_2022::ID {
        return Ok(());
    }

    let mint_data = mint_info.try_borrow_data()?;
    let mint_state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;
    let extensions = mint_state.get_extension_types()?;

    for extension in extensions {
        // The delegate can move tokens out of the vault at any time.
        if extension == ExtensionType::PermanentDelegate {
            return err!(ErrorCode::UnsupportedMint);
        }
        // Rejected even at a 0% rate: the fee can be raised later, shrinking
        // every payout, and fees withheld in the vault would stop it closing.
        if extension == ExtensionType::TransferFeeConfig {
            return err!(ErrorCode::UnsupportedMint);
        }
        // A hook program, even one set after creation, can make every transfer
        // out of the vault fail.
        if extension == ExtensionType::TransferHook {
            return err!(ErrorCode::UnsupportedMint);
        }
    }
    Ok(())
}

fn build_tiers(tier_amounts: &[u64]) -> Vec<PrizeTier> {
    let mut tiers = Vec::new();
    for amount in tier_amounts {
        tiers.push(PrizeTier {
            amount: *amount,
            claimed: false,
            badge_minted: false,
            winner: None,
            votes: Vec::new(),
        });
    }
    tiers
}

// Moves the whole prize pool from the organizer into the vault, then checks
// that the vault holds exactly that amount. The mint check above already
// rejects tokens that take a fee on transfer; this check holds whatever the
// mint's settings are.
fn deposit_prize_pool(accounts: &mut InitializeEscrow, prize_total: u64) -> Result<()> {
    let transfer_accounts = TransferChecked {
        from: accounts.organizer_token_account.to_account_info(),
        mint: accounts.mint.to_account_info(),
        to: accounts.vault.to_account_info(),
        authority: accounts.organizer.to_account_info(),
    };
    let transfer_context = CpiContext::new(accounts.token_program.key(), transfer_accounts);
    token_interface::transfer_checked(transfer_context, prize_total, accounts.mint.decimals)?;

    // The account data in memory still shows the balance from before the
    // transfer, so it is read again from the account itself.
    accounts.vault.reload()?;
    require!(
        accounts.vault.amount == prize_total,
        ErrorCode::DepositMismatch
    );
    Ok(())
}
