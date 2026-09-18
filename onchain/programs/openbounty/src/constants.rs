use anchor_lang::prelude::*;

// Seed prefixes for the two PDAs. Exported to the IDL so clients derive
// the same addresses without hard-coding the strings.
#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

// Length limits are in bytes, because account space is allocated in bytes.
pub const MAX_TITLE_LEN: usize = 50;
pub const MAX_METADATA_URI_LEN: usize = 100;

pub const MAX_JUDGES: usize = 5;
pub const MAX_TIERS: usize = 4;
