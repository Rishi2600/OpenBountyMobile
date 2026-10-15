use anchor_lang::prelude::*;

// Every protocol limit and PDA seed lives here, so each can be changed in one
// place. They match the OpenBounty web program, except that bounty IDs come
// from a per-organizer u64 counter instead of a u8 nonce.
//
// The size limits are `usize` because `#[max_len]` account sizing needs them
// in `usize` arithmetic. `#[constant]` cannot export a `usize` to the IDL, so
// only the seeds and the `u64`/`i64` limits appear there.

// Organizer profile PDA: ["organizer", organizer]. It holds the counter that
// hands out bounty IDs.
#[constant]
pub const ORGANIZER_SEED: &[u8] = b"organizer";

// Escrow PDA: ["escrow", organizer, bounty_id as u64 little-endian].
#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";

// Vault PDA: ["vault", organizer, bounty_id as u64 little-endian].
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

// Entry PDA: ["submission", escrow, submitter]. An escrow address is never
// reused, so the escrow and the submitter are enough to make it unique.
#[constant]
pub const SUBMISSION_SEED: &[u8] = b"submission";

pub const MAX_JUDGES: usize = 5;
pub const MAX_PRIZE_TIERS: usize = 4;

// Length limits are in bytes (UTF-8), because account space is allocated in
// bytes.
pub const MAX_TITLE_LENGTH: usize = 50;
pub const MAX_METADATA_URI_LENGTH: usize = 100;
pub const MAX_ENTRY_TITLE_LENGTH: usize = 50;
pub const MAX_ENTRY_URL_LENGTH: usize = 100;
pub const MAX_ENTRY_DESCRIPTION_LENGTH: usize = 280;

// Minimum prize per tier, in lamports (0.001 SOL). A tier must also be at
// least the rent-exempt minimum for a data-less account, so paying a brand-new
// winner wallet can never fail for leaving it below rent exemption.
#[constant]
pub const MIN_PRIZE_AMOUNT: u64 = 1_000_000;

// The deadline may be at most this far in the future: 365 days, in seconds.
#[constant]
pub const MAX_DEADLINE_AHEAD: i64 = 365 * 24 * 60 * 60;

// The claim window the organizer picks runs from the deadline. It must be
// between 1 day and 90 days, in seconds.
#[constant]
pub const MIN_CLAIM_WINDOW: i64 = 24 * 60 * 60;

#[constant]
pub const MAX_CLAIM_WINDOW: i64 = 90 * 24 * 60 * 60;
