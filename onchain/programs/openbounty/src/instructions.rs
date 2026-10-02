// Each instruction's accounts struct and handler live in their own file. The
// `pub use` lines make the accounts structs reachable from the crate root,
// which Anchor's #[program] macro needs.
pub mod badge;
pub mod claim;
pub mod initialize;
pub mod refund;
pub mod vote;

pub use badge::*;
pub use claim::*;
pub use initialize::*;
pub use refund::*;
pub use vote::*;
