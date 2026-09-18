use anchor_lang::prelude::*;

// These messages are shown directly to users in the mobile app, so they
// are written as plain sentences. Codes start at 6000, in this order.
#[error_code]
pub enum ErrorCode {
    #[msg("Title must be between 1 and 50 bytes long.")]
    InvalidTitleLength,
    #[msg("Metadata URI must be at most 100 bytes long.")]
    InvalidMetadataUriLength,
    #[msg("A bounty needs at least one judge.")]
    NoJudges,
    #[msg("A bounty can have at most 5 judges.")]
    TooManyJudges,
    #[msg("Vote threshold must be at least 1 and no more than the number of judges.")]
    InvalidThreshold,
    #[msg("A bounty needs at least one prize tier.")]
    NoTiers,
    #[msg("A bounty can have at most 4 prize tiers.")]
    TooManyTiers,
    #[msg("Every prize tier must have an amount greater than zero.")]
    InvalidAmount,
    #[msg("The deadline must be in the future.")]
    InvalidDeadline,
    #[msg("That prize tier does not exist.")]
    InvalidTierIndex,
    #[msg("Only a judge of this bounty can vote.")]
    NotAJudge,
    #[msg("You have already voted on this prize tier.")]
    AlreadyVoted,
    #[msg("This prize tier already has a winner.")]
    TierAlreadyFinalized,
    #[msg("Voting for this bounty has closed.")]
    DeadlinePassed,
    #[msg("This prize tier does not have a winner yet.")]
    TierNotFinalized,
    #[msg("This prize has already been claimed.")]
    TierAlreadyClaimed,
    #[msg("Only the winner of this prize tier can claim it.")]
    NotWinner,
    #[msg("Only the organizer of this bounty can do this.")]
    Unauthorized,
    #[msg("Unclaimed funds can only be refunded after the deadline.")]
    DeadlineNotPassed,
    #[msg("There are no unclaimed funds to refund.")]
    NoUnclaimedFunds,
    #[msg("The prize amounts are too large to add up safely.")]
    ArithmeticOverflow,
}
