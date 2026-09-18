use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::VAULT_SEED;

// Moves lamports out of the vault. The vault is owned by the System Program,
// so this program cannot change its balance directly. Instead it asks the
// System Program to transfer, signing as the vault with the vault's PDA seeds.
// This only works because the vault holds no data; a System Program transfer
// refuses to debit an account that carries data.
pub fn transfer_from_vault<'info>(
    vault: &SystemAccount<'info>,
    to: AccountInfo<'info>,
    organizer: Pubkey,
    nonce: u8,
    vault_bump: u8,
    amount: u64,
) -> Result<()> {
    let nonce_bytes = [nonce];
    let bump_bytes = [vault_bump];
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, organizer.as_ref(), &nonce_bytes, &bump_bytes];
    let signer_seeds: &[&[&[u8]]] = &[vault_seeds];

    let transfer_accounts = system_program::Transfer {
        from: vault.to_account_info(),
        to,
    };
    let transfer_context =
        CpiContext::new_with_signer(system_program::ID, transfer_accounts, signer_seeds);
    system_program::transfer(transfer_context, amount)
}
