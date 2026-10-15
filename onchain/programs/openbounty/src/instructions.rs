// Each instruction's accounts struct and handler live in their own file. The
// `pub use` lines make the accounts structs reachable from the crate root,
// which Anchor's #[program] macro needs.
pub mod initialize;

pub use initialize::*;
