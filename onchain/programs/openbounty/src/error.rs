use anchor_lang::prelude::*;

// The same errors, in the same order, as the OpenBounty web program. Codes
// start at 6000, and a variant's position is its code. Clients match on
// codes, so once deployed, new errors are only ever added at the end.
#[error_code]
pub enum OpenBountyError {
    // Configuration (initialize_escrow)
    #[msg("Title is empty or exceeds the maximum length")]
    InvalidTitle,
    #[msg("Metadata URI exceeds the maximum length")]
    InvalidMetadataUri,
    #[msg("Judge list is empty or exceeds the maximum number of judges")]
    InvalidJudgeCount,
    #[msg("Judge list contains a duplicate judge")]
    DuplicateJudge,
    #[msg("The organizer cannot be a judge")]
    OrganizerCannotBeJudge,
    #[msg("Vote threshold must be a strict majority of the judges")]
    InvalidVoteThreshold,
    #[msg("Prize tier list is empty or exceeds the maximum number of tiers")]
    InvalidPrizeTierCount,
    #[msg("Prize tier amount is below the minimum")]
    InvalidPrizeAmount,
    #[msg("Total prize pool overflows")]
    PrizePoolOverflow,
    #[msg("Deadline must be in the future and at most 365 days away")]
    InvalidDeadline,
    #[msg("Vault was not funded with the exact prize pool")]
    IncorrectFunding,

    // Authorization
    #[msg("Signer is not the organizer of this escrow")]
    UnauthorizedOrganizer,
    #[msg("Signer is not a judge of this escrow")]
    UnauthorizedJudge,
    #[msg("The organizer cannot vote")]
    OrganizerCannotVote,
    #[msg("Signer is not the winner of this prize tier")]
    NotWinner,

    // Voting (vote_winner)
    #[msg("Prize tier index is out of range")]
    InvalidTier,
    #[msg("Candidate is not eligible to win")]
    InvalidCandidate,
    #[msg("Judge has already voted on this prize tier")]
    DuplicateVote,
    #[msg("Prize tier already has a finalized winner")]
    TierAlreadyFinalized,

    // Claims (claim_prize)
    #[msg("Prize tier has no finalized winner")]
    TierNotFinalized,
    #[msg("Prize has already been claimed")]
    PrizeAlreadyClaimed,

    // Refunds (refund_unclaimed)
    #[msg("Deadline has not been reached")]
    DeadlineNotReached,
    #[msg("Prize tier is not eligible for refund")]
    RefundNotEligible,

    // Account relationships
    #[msg("Organizer account does not match the escrow organizer")]
    OrganizerMismatch,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    // Deadlines and the claim window
    #[msg("Voting closed at the deadline")]
    VotingClosed,
    #[msg("Entry deadline must be in the future and no later than the deadline")]
    InvalidSubmissionsDeadline,
    #[msg("Claim window is outside the allowed range")]
    InvalidClaimWindow,
    #[msg("The claim window for this prize has closed")]
    ClaimWindowClosed,
    #[msg("The winner can still claim this prize")]
    ClaimWindowOpen,

    // Entries (submit_entry, close_entry)
    #[msg("Entries for this bounty have closed")]
    SubmissionsClosed,
    #[msg("The organizer cannot enter their own bounty")]
    OrganizerCannotSubmit,
    #[msg("A judge cannot enter a bounty they judge")]
    JudgeCannotSubmit,
    #[msg("Entry name is empty or exceeds the maximum length")]
    InvalidEntryTitle,
    #[msg("Entry link is empty or exceeds the maximum length")]
    InvalidEntryUrl,
    #[msg("Entry description exceeds the maximum length")]
    InvalidEntryDescription,
    #[msg("An entry can be closed only after the bounty's deadline")]
    EntryLocked,
}
