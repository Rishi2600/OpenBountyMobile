use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::ESCROW_SEED;
use crate::state::Escrow;

// The vault is a token account whose authority is the escrow. Only this
// program can sign as the escrow, by supplying the escrow's seeds, so these
// two functions are the only way tokens or rent ever leave a vault.

// Moves `amount` tokens from the vault to `to`.
pub fn transfer_from_vault<'info>(
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    escrow: &Account<'info, Escrow>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    let organizer = escrow.organizer;
    let bounty_id_bytes = escrow.bounty_id.to_le_bytes();
    let bump_bytes = [escrow.bump];
    let escrow_seeds: &[&[u8]] = &[
        ESCROW_SEED,
        organizer.as_ref(),
        &bounty_id_bytes,
        &bump_bytes,
    ];
    let signer_seeds: &[&[&[u8]]] = &[escrow_seeds];

    let transfer_accounts = TransferChecked {
        from: vault.to_account_info(),
        mint: mint.to_account_info(),
        to: to.to_account_info(),
        authority: escrow.to_account_info(),
    };
    let transfer_context =
        CpiContext::new_with_signer(token_program.key(), transfer_accounts, signer_seeds);
    token_interface::transfer_checked(transfer_context, amount, mint.decimals)
}

// Closes the vault and sends its rent to `destination`. The token program
// only closes an empty token account, so the vault must be emptied first.
pub fn close_vault<'info>(
    vault: &InterfaceAccount<'info, TokenAccount>,
    destination: AccountInfo<'info>,
    escrow: &Account<'info, Escrow>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    let organizer = escrow.organizer;
    let bounty_id_bytes = escrow.bounty_id.to_le_bytes();
    let bump_bytes = [escrow.bump];
    let escrow_seeds: &[&[u8]] = &[
        ESCROW_SEED,
        organizer.as_ref(),
        &bounty_id_bytes,
        &bump_bytes,
    ];
    let signer_seeds: &[&[&[u8]]] = &[escrow_seeds];

    let close_accounts = CloseAccount {
        account: vault.to_account_info(),
        destination,
        authority: escrow.to_account_info(),
    };
    let close_context =
        CpiContext::new_with_signer(token_program.key(), close_accounts, signer_seeds);
    token_interface::close_account(close_context)
}
