use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::OpenBountyError;
use crate::events::{TierFinalized, VoteCast};
use crate::state::{Escrow, Vote};

#[derive(Accounts)]
pub struct VoteWinner<'info> {
    // Must be one of `escrow.judges`. Each judge signs their own vote.
    pub judge: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.organizer.as_ref(), &escrow.bounty_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
}

pub fn handle_vote_winner(
    ctx: Context<VoteWinner>,
    tier_index: u8,
    candidate: Pubkey,
) -> Result<()> {
    let judge = ctx.accounts.judge.key();
    let escrow_key = ctx.accounts.escrow.key();
    let now = Clock::get()?.unix_timestamp;

    let escrow = &ctx.accounts.escrow;
    require!(
        judge != escrow.organizer,
        OpenBountyError::OrganizerCannotVote
    );
    require!(escrow.is_judge(&judge), OpenBountyError::UnauthorizedJudge);
    // Voting closes at the deadline (inclusive).
    require!(now <= escrow.deadline, OpenBountyError::VotingClosed);
    require_eligible_candidate(escrow, &escrow_key, &candidate)?;
    let threshold = escrow.vote_threshold as usize;

    let escrow = &mut ctx.accounts.escrow;
    let tier = escrow
        .prize_tiers
        .get_mut(tier_index as usize)
        .ok_or(OpenBountyError::InvalidTier)?;
    require!(tier.winner.is_none(), OpenBountyError::TierAlreadyFinalized);
    // Votes are final: one per judge per tier, never changed.
    require!(!tier.has_voted(&judge), OpenBountyError::DuplicateVote);

    tier.votes.push(Vote { judge, candidate });
    emit!(VoteCast {
        escrow: escrow_key,
        tier_index,
        judge,
        candidate,
    });

    // The threshold is a strict majority, so only one candidate can ever
    // reach it on a tier.
    if tier.count_votes_for(&candidate) >= threshold {
        tier.winner = Some(candidate);
        emit!(TierFinalized {
            escrow: escrow_key,
            tier_index,
            winner: candidate,
        });
    }
    Ok(())
}

// A winner can never be the organizer, a judge, the all-zero key, or this
// bounty's own escrow or vault. Ruling out the organizer also means
// claim_prize never gets the same account as both winner and organizer.
fn require_eligible_candidate(
    escrow: &Escrow,
    escrow_key: &Pubkey,
    candidate: &Pubkey,
) -> Result<()> {
    let bounty_id_bytes = escrow.bounty_id.to_le_bytes();
    let vault_bump = [escrow.vault_bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        escrow.organizer.as_ref(),
        &bounty_id_bytes,
        &vault_bump,
    ];
    let vault = Pubkey::create_program_address(vault_seeds, &crate::ID)
        .map_err(|_| OpenBountyError::InvalidCandidate)?;

    require!(
        *candidate != escrow.organizer,
        OpenBountyError::InvalidCandidate
    );
    require!(
        !escrow.is_judge(candidate),
        OpenBountyError::InvalidCandidate
    );
    require!(
        *candidate != Pubkey::default(),
        OpenBountyError::InvalidCandidate
    );
    require!(*candidate != *escrow_key, OpenBountyError::InvalidCandidate);
    require!(*candidate != vault, OpenBountyError::InvalidCandidate);
    Ok(())
}
