use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::*;
use crate::error::OpenBountyError;
use crate::events::EscrowInitialized;
use crate::state::{Escrow, OrganizerProfile, PrizeTier};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeEscrowParams {
    pub title: String,
    pub metadata_uri: String,
    pub judges: Vec<Pubkey>,
    pub vote_threshold: u8,
    // One entry per prize tier, in lamports. The vault is funded with their
    // sum in this same instruction.
    pub prize_amounts: Vec<u64>,
    // Unix timestamp (seconds): entries close. At most `deadline`.
    pub submissions_deadline: i64,
    // Unix timestamp (seconds): voting closes.
    pub deadline: i64,
    // Seconds after `deadline` during which winners can still claim.
    pub claim_window: i64,
}

#[derive(Accounts)]
pub struct InitializeEscrow<'info> {
    // Creates the escrow and funds the complete prize pool.
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

    // A program-controlled, data-less system account that holds the prize
    // pool.
    #[account(
        mut,
        seeds = [
            VAULT_SEED,
            organizer.key().as_ref(),
            &organizer_profile.next_bounty_id.to_le_bytes()
        ],
        bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_escrow(
    ctx: Context<InitializeEscrow>,
    params: InitializeEscrowParams,
) -> Result<()> {
    let organizer = ctx.accounts.organizer.key();
    let now = Clock::get()?.unix_timestamp;

    // The checks run in the same order as in the web program, so an input
    // with several problems reports the same error in both.
    require_valid_title_and_uri(&params)?;
    require_valid_judges(&params.judges, &organizer)?;
    require_majority_threshold(params.vote_threshold, params.judges.len())?;
    let prize_pool = sum_prize_amounts(&params.prize_amounts)?;
    let claim_deadline = check_dates_and_get_claim_deadline(&params, now)?;

    let bounty_id = ctx.accounts.organizer_profile.next_bounty_id;
    let next_bounty_id = bounty_id
        .checked_add(1)
        .ok_or(OpenBountyError::ArithmeticOverflow)?;
    ctx.accounts.organizer_profile.next_bounty_id = next_bounty_id;

    let escrow = &mut ctx.accounts.escrow;
    escrow.organizer = organizer;
    escrow.bounty_id = bounty_id;
    escrow.bump = ctx.bumps.escrow;
    escrow.vault_bump = ctx.bumps.vault;
    escrow.vote_threshold = params.vote_threshold;
    escrow.created_at = now;
    escrow.submissions_deadline = params.submissions_deadline;
    escrow.deadline = params.deadline;
    escrow.claim_deadline = claim_deadline;
    escrow.title = params.title;
    escrow.metadata_uri = params.metadata_uri;
    escrow.judges = params.judges;
    escrow.prize_tiers = build_prize_tiers(&params.prize_amounts);

    fund_vault(&ctx, prize_pool)?;

    emit!(EscrowInitialized {
        escrow: ctx.accounts.escrow.key(),
        organizer,
        bounty_id,
        prize_pool,
        submissions_deadline: params.submissions_deadline,
        deadline: params.deadline,
        claim_deadline,
    });
    Ok(())
}

fn require_valid_title_and_uri(params: &InitializeEscrowParams) -> Result<()> {
    require!(
        !params.title.is_empty() && params.title.len() <= MAX_TITLE_LENGTH,
        OpenBountyError::InvalidTitle
    );
    require!(
        params.metadata_uri.len() <= MAX_METADATA_URI_LENGTH,
        OpenBountyError::InvalidMetadataUri
    );
    Ok(())
}

fn require_valid_judges(judges: &[Pubkey], organizer: &Pubkey) -> Result<()> {
    require!(
        !judges.is_empty() && judges.len() <= MAX_JUDGES,
        OpenBountyError::InvalidJudgeCount
    );
    for i in 0..judges.len() {
        // Only earlier entries are compared, so each pair is checked once.
        for j in 0..i {
            require!(judges[i] != judges[j], OpenBountyError::DuplicateJudge);
        }
        require!(
            judges[i] != *organizer,
            OpenBountyError::OrganizerCannotBeJudge
        );
    }
    Ok(())
}

// A strict majority: two disjoint groups of judges can never both reach it,
// so a tier can never have two winners.
fn require_majority_threshold(threshold: u8, judge_count: usize) -> Result<()> {
    let threshold = threshold as usize;
    require!(
        threshold <= judge_count && threshold * 2 > judge_count,
        OpenBountyError::InvalidVoteThreshold
    );
    Ok(())
}

// Checks every tier amount and returns the total prize pool.
fn sum_prize_amounts(amounts: &[u64]) -> Result<u64> {
    require!(
        !amounts.is_empty() && amounts.len() <= MAX_PRIZE_TIERS,
        OpenBountyError::InvalidPrizeTierCount
    );
    // A prize must also keep a brand-new winner wallet rent-exempt, so paying
    // it can never fail.
    let rent_exempt_minimum = Rent::get()?.minimum_balance(0);
    let mut min_prize = MIN_PRIZE_AMOUNT;
    if rent_exempt_minimum > min_prize {
        min_prize = rent_exempt_minimum;
    }

    let mut prize_pool: u64 = 0;
    for amount in amounts {
        require!(*amount >= min_prize, OpenBountyError::InvalidPrizeAmount);
        prize_pool = prize_pool
            .checked_add(*amount)
            .ok_or(OpenBountyError::PrizePoolOverflow)?;
    }
    Ok(prize_pool)
}

// Checks the three dates and returns the claim deadline: the deadline plus
// the organizer's claim window.
fn check_dates_and_get_claim_deadline(params: &InitializeEscrowParams, now: i64) -> Result<i64> {
    let latest_deadline = now
        .checked_add(MAX_DEADLINE_AHEAD)
        .ok_or(OpenBountyError::ArithmeticOverflow)?;
    require!(
        params.deadline > now && params.deadline <= latest_deadline,
        OpenBountyError::InvalidDeadline
    );
    require!(
        params.submissions_deadline > now && params.submissions_deadline <= params.deadline,
        OpenBountyError::InvalidSubmissionsDeadline
    );
    require!(
        params.claim_window >= MIN_CLAIM_WINDOW && params.claim_window <= MAX_CLAIM_WINDOW,
        OpenBountyError::InvalidClaimWindow
    );
    let claim_deadline = params
        .deadline
        .checked_add(params.claim_window)
        .ok_or(OpenBountyError::ArithmeticOverflow)?;
    Ok(claim_deadline)
}

fn build_prize_tiers(amounts: &[u64]) -> Vec<PrizeTier> {
    let mut tiers = Vec::new();
    for amount in amounts {
        tiers.push(PrizeTier {
            amount: *amount,
            winner: None,
            claimed: false,
            refunded: false,
            votes: Vec::new(),
        });
    }
    tiers
}

// Moves the whole prize pool into the vault and checks that the vault
// received exactly that much. Lamports someone sent to the vault address
// earlier are tolerated, so nobody can block a bounty by pre-funding its
// vault: payouts use tier amounts, and the leftover goes back to the
// organizer when the escrow closes.
fn fund_vault(ctx: &Context<InitializeEscrow>, prize_pool: u64) -> Result<()> {
    let vault_before = ctx.accounts.vault.lamports();
    let transfer_accounts = Transfer {
        from: ctx.accounts.organizer.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
    };
    let transfer_context = CpiContext::new(ctx.accounts.system_program.key(), transfer_accounts);
    transfer(transfer_context, prize_pool)?;

    let vault_after = ctx.accounts.vault.lamports();
    require!(
        vault_after.checked_sub(vault_before) == Some(prize_pool),
        OpenBountyError::IncorrectFunding
    );
    Ok(())
}
