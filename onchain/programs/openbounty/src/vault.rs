use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::VAULT_SEED;
use crate::events::EscrowClosed;
use crate::state::Escrow;

// The vault is a data-less system account at a PDA of this program. Only this
// program can sign for it, by supplying its seeds, so these two functions are
// the only way lamports ever leave a vault. Shared by claim_prize and
// refund_unclaimed.

// Moves `amount` lamports from the vault to `to`.
pub fn pay_from_vault<'info>(
    escrow: &Account<'info, Escrow>,
    vault: &SystemAccount<'info>,
    to: AccountInfo<'info>,
    system_program: &Program<'info, System>,
    amount: u64,
) -> Result<()> {
    let organizer = escrow.organizer;
    let bounty_id_bytes = escrow.bounty_id.to_le_bytes();
    let vault_bump = [escrow.vault_bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        organizer.as_ref(),
        &bounty_id_bytes,
        &vault_bump,
    ];
    let signer_seeds: &[&[&[u8]]] = &[vault_seeds];

    let transfer_accounts = Transfer {
        from: vault.to_account_info(),
        to,
    };
    let transfer_context =
        CpiContext::new_with_signer(system_program.key(), transfer_accounts, signer_seeds);
    transfer(transfer_context, amount)
}

// Once every tier is claimed or refunded: sends whatever is left in the vault
// to the organizer, then closes the escrow and returns its rent to the
// organizer. The leftover can only be lamports someone sent to the vault on
// their own, because every tier's amount has already been paid out.
pub fn close_if_settled<'info>(
    escrow: &mut Account<'info, Escrow>,
    vault: &SystemAccount<'info>,
    organizer: AccountInfo<'info>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    if !escrow.is_settled() {
        return Ok(());
    }

    let remainder = vault.lamports();
    if remainder > 0 {
        pay_from_vault(escrow, vault, organizer.clone(), system_program, remainder)?;
    }

    emit!(EscrowClosed {
        escrow: escrow.key()
    });
    escrow.close(organizer)
}
