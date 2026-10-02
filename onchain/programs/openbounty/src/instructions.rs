// Each instruction is registered here again as it is converted to the v2
// account model. Until then its file stays in instructions/ but is not
// compiled, so every step of the migration still builds.
pub mod claim;
pub mod initialize;
pub mod vote;

pub use claim::*;
pub use initialize::*;
pub use vote::*;
