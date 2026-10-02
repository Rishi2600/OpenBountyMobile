use anchor_lang::prelude::*;

// Seed prefixes for the PDAs. Exported to the IDL so clients derive the
// same addresses without hard-coding the strings.
#[constant]
pub const ORGANIZER_SEED: &[u8] = b"organizer";

#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

// Written into every escrow at creation and checked by every instruction
// that reads one, so an account from a different layout is rejected instead
// of being misread.
#[constant]
pub const ESCROW_VERSION: u8 = 2;

// A winner always has at least this long after voting closes to claim,
// before the organizer can refund their tier. Seven days, in seconds. The
// InvalidClaimDeadline error message states the same figure.
#[constant]
pub const MIN_CLAIM_WINDOW: i64 = 7 * 24 * 60 * 60;

// Length limits are in bytes, because account space is allocated in bytes.
pub const MAX_TITLE_LEN: usize = 50;
pub const MAX_METADATA_URI_LEN: usize = 100;

pub const MAX_JUDGES: usize = 5;
pub const MAX_TIERS: usize = 4;
