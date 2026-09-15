# OpenBounty

Trustless on-chain escrow for hackathon prize money, on Solana.

Organizers lock prize funds in an on-chain vault before the hackathon
starts. Judges vote directly on-chain, each signing their own
transaction. Winners claim their prize permissionlessly, straight from
the vault. The organizer can never withdraw locked funds early, and can
never influence who wins.

## The Problem

Hackathon organizers promise prize money but don't always pay. Payments
get delayed, disputed, or never sent, and participants have no way to
verify the money even exists before they commit weeks of work.

## How It Works

1. **Lock** — the organizer creates a bounty with prize tiers, a judge
   list, a vote threshold, and a deadline. The full prize pool transfers
   into a program-owned vault in the same transaction. There is no path
   for the organizer to withdraw it early.
2. **Vote** — each judge submits their own signed transaction naming a
   candidate for a tier. The Solana runtime proves every signature. Once
   a candidate reaches the vote threshold, that tier finalizes
   automatically.
3. **Claim** — the winner of a finalized tier claims directly from the
   vault. No organizer involvement, no approval step.
4. **Refund** — after the deadline, the organizer can reclaim only what
   was never claimed. Accounts close automatically and rent returns to
   the organizer.

No role is stored as a flag anywhere in state. Organizer, judge, and
winner are all derived per-escrow at the moment of each call.

## Repository Layout

This is a single repository with two independent modules. They share no
code and no build tooling.

```
OpenBounty/
├── onchain/     Anchor / Rust program (Solana devnet) — the source of truth
└── offchain/    Flutter mobile app — the client
```

The only coupling between them is two values: the deployed **program
ID** and the generated **IDL**, both produced by the onchain build and
consumed by the mobile app at runtime. See `docs/` for the full
structure write-up.

## Stack

| Module | Stack |
|---|---|
| onchain | Anchor, Rust, Solana devnet |
| offchain | Flutter, Dart, `coral_xyz` (Anchor client), Mobile Wallet Adapter |

## Toolchain

Built and tested against:

| Tool | Version |
|---|---|
| Anchor CLI | 1.1.2 |
| Solana CLI | 3.1.10 |
| Surfpool | 1.5.0 |
| Rust | 1.98.1 |
| Node.js | 24.21.0 |
| Yarn | 1.22.22 |

Anchor 1.x is a major release with breaking changes relative to 0.3x —
notably the TypeScript package rename to `@anchor-lang/core` and
Surfpool replacing the local validator for `anchor test`.

## Onchain — Build, Test, Deploy

Prerequisites: Rust, Anchor CLI, Surfpool, Node.js, yarn. Surfpool is
required because `anchor test` uses it as the default backend. The
Solana CLI is not needed on PATH for most Anchor commands as of Anchor
1.0, but is still needed for `solana-keygen`, `solana config`, and
similar.

```bash
cd onchain
anchor build
anchor test
```

Deploy to devnet:

```bash
# TODO: fill in once deployed
```

**Deployed program ID (devnet):** `TODO`

## Offchain — Run the Mobile App

Prerequisites: Flutter SDK, an Android device or emulator, and an
MWA-compatible wallet app (Phantom or Solflare) installed and set to
devnet.

```bash
# TODO: fill in once the Flutter app is scaffolded
```

## Demo

TODO: demo video link.

## License

TODO