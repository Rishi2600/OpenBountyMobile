use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::OpenBountyError;
use crate::events::EntrySubmitted;
use crate::state::{Escrow, Submission};

#[derive(Accounts)]
pub struct SubmitEntry<'info> {
    // The builder. Pays the entry's rent and gets it back through
    // close_entry. If judges vote for this wallet, the prize goes to it.
    #[account(mut)]
    pub submitter: Signer<'info>,

    #[account(
        seeds = [ESCROW_SEED, escrow.organizer.as_ref(), &escrow.bounty_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,

    // One per wallet per bounty: a second entry fails because the address is
    // already in use.
    #[account(
        init,
        payer = submitter,
        space = Submission::LEN,
        seeds = [SUBMISSION_SEED, escrow.key().as_ref(), submitter.key().as_ref()],
        bump
    )]
    pub submission: Account<'info, Submission>,

    pub system_program: Program<'info, System>,
}

pub fn handle_submit_entry(
    ctx: Context<SubmitEntry>,
    title: String,
    url: String,
    description: String,
) -> Result<()> {
    let submitter = ctx.accounts.submitter.key();
    let escrow = &ctx.accounts.escrow;
    let now = Clock::get()?.unix_timestamp;

    require!(
        now <= escrow.submissions_deadline,
        OpenBountyError::SubmissionsClosed
    );
    // The organizer and the judges have a conflict of interest.
    require!(
        submitter != escrow.organizer,
        OpenBountyError::OrganizerCannotSubmit
    );
    require!(
        !escrow.is_judge(&submitter),
        OpenBountyError::JudgeCannotSubmit
    );
    require_valid_entry_fields(&title, &url, &description)?;

    let escrow_key = escrow.key();
    let close_after = escrow.deadline;

    let submission = &mut ctx.accounts.submission;
    submission.escrow = escrow_key;
    submission.submitter = submitter;
    submission.submitted_at = now;
    submission.close_after = close_after;
    submission.bump = ctx.bumps.submission;
    submission.title = title;
    submission.url = url;
    submission.description = description;

    emit!(EntrySubmitted {
        escrow: escrow_key,
        submission: submission.key(),
        submitter,
    });
    Ok(())
}

fn require_valid_entry_fields(title: &str, url: &str, description: &str) -> Result<()> {
    require!(
        !title.is_empty() && title.len() <= MAX_ENTRY_TITLE_LENGTH,
        OpenBountyError::InvalidEntryTitle
    );
    require!(
        !url.is_empty() && url.len() <= MAX_ENTRY_URL_LENGTH,
        OpenBountyError::InvalidEntryUrl
    );
    require!(
        description.len() <= MAX_ENTRY_DESCRIPTION_LENGTH,
        OpenBountyError::InvalidEntryDescription
    );
    Ok(())
}
