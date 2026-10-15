// Each instruction's accounts struct and handler live in their own file. The
// `pub use` lines make the accounts structs reachable from the crate root,
// which Anchor's #[program] macro needs.
pub mod claim;
pub mod close_entry;
pub mod initialize;
pub mod refund;
pub mod submit_entry;
pub mod vote;

pub use claim::*;
pub use close_entry::*;
pub use initialize::*;
pub use refund::*;
pub use submit_entry::*;
pub use vote::*;
