# OpenBounty

Trust-minimized on-chain escrow for bounties on Solana: any paid work,
not only hackathons.

An organizer locks the full prize pool in an on-chain vault before
anyone starts work. Judges vote directly on-chain, each signing their own
transaction. When a candidate reaches the vote threshold for a prize
tier, the tier is decided automatically, and the winner claims straight
from the vault. The organizer can reclaim only what is still unclaimed,
and only after the claim period has ended.

**Deployed program ID (devnet):** `3xbu7yrMBpbhtzb5FqJgTydvEtPHBKWoQAQ5Vaw5nMCM`
(v2, deployed in slot 506727070)

## The Problem

People who post paid work, whether bounties, contests or hackathons,
promise prize money but don't always pay. Payments get delayed, disputed
or never sent, and participants have no way to check that the money
exists before they commit weeks of work.

## How It Works

1. **Lock.** The organizer creates a bounty with:
   - up to 4 prize tiers
   - up to 5 judges and a vote threshold
   - a voting deadline, and a claim deadline at least 7 days after it

   The full prize pool moves into a program-controlled vault in the same
   transaction. Prizes are SPL tokens (classic SPL Token or Token-2022),
   so native SOL works as wrapped SOL. Every bounty gets a new ID from
   the organizer's own counter, so a bounty's address is never reused.
2. **Vote.** Each judge signs their own `cast_vote` transaction naming a
   candidate for a tier. The vote that brings a candidate to the
   threshold decides the tier in the same transaction. Votes cannot be
   changed.
3. **Claim.** The tier's winner claims straight from the vault, at any
   time until the claim deadline. There is no approval step and no
   organizer involvement. If the winner has no token account yet, the
   claim creates one.
4. **Badge (optional).** The winner can mint a Metaplex Core "winner"
   badge as on-chain proof of the win. There is one per tier, and it
   cannot be edited.
5. **Refund.** After the claim deadline, the organizer can reclaim
   whatever was never claimed. The bounty's accounts then close, and
   their rent returns to the organizer.

No role is stored as a flag anywhere. Organizer, judge and winner are
derived per bounty at the moment of each call. The program emits events
for each of these steps, to drive notifications.

## Trust Assumptions

**What the program guarantees**, for the code as deployed:

- The prize pool is fully deposited before the bounty exists. Creation
  fails unless the vault receives exactly the prize total.
- The organizer cannot withdraw early. Prize tokens reach the organizer
  only by a refund, and only after the claim deadline.
- A decided prize stays claimable for at least 7 days after voting
  closes.
- Only the listed judges decide winners. The organizer cannot be a judge,
  a judge cannot be listed twice, and each judge votes at most once per
  tier.
- Only a tier's winner can claim it or mint its badge, and only once.
- A transaction built for one bounty can never affect another. Bounty
  addresses are never reused.
- Tokens whose issuer could take funds from the vault, or skim or block
  transfers from it, are rejected. These are Token-2022 mints with a
  permanent delegate, a transfer fee or a transfer hook.

**What it does not guarantee:**

- **The code can still be changed.** The upgrade authority is a single
  wallet, `CCsJcqHJRLELykJ1GCTWvihUGFkFaP1eRws1MUAE6Ev6`, which could
  deploy new code, including code that moves escrowed funds. Moving it to
  a Squads multisig is planned but **not done yet**.
- **Token issuers can still freeze or pause.** A mint's freeze authority,
  or a Token-2022 pause authority, can freeze the vault or a winner's
  account. An organizer who controls that authority could block claims
  until the claim deadline and then refund. Clients must show only
  bounties in allowlisted tokens, such as SOL and USDC.
- **Judge independence.** The organizer chooses the judges. The program
  guarantees that the listed judges decide, not that they are
  independent. Judges can name any wallet as a winner, including the
  organizer's.
- **Multisig judges are unverified.** A judge may be a multisig vault,
  for example Squads, because a vote needs only a signature. This is
  expected to work but has **not yet been verified on devnet**.
- **Badges depend on Metaplex.** Badges use the Metaplex Core program,
  which Metaplex can upgrade. Prize funds never pass through it.

## Repository Layout

This is a single repository with two independent modules. They share no
code and no build tooling.

```
OpenBounty/
├── onchain/     Anchor / Rust program (Solana devnet), the source of truth
├── offchain/    Flutter mobile app, the client
└── assets/      Static badge metadata and image, served from this repo
```

The only coupling between the two modules is the deployed **program ID**
and the generated **IDL**, both produced by the onchain build. The
detailed client integration guide, the implementation record and the IDL
are shared with the client developer directly; they are not stored in
this repository.

`assets/badge.json` and `assets/badge.png` are referenced by the deployed
program through a fixed URL on the `master` branch. Do not move or rename
them.

## Stack

| Module | Stack |
|---|---|
| onchain | Anchor, Rust, `anchor-spl` (SPL Token and Token-2022), Metaplex Core (`mpl-core`), Solana devnet |
| offchain | Flutter, Dart, `coral_xyz` (Anchor client), Mobile Wallet Adapter |

## Toolchain

Built and tested against:

| Tool | Version |
|---|---|
| Anchor CLI | 1.1.2 |
| `anchor-lang` / `anchor-spl` crates | 1.2.0 |
| `mpl-core` crate | 0.12.1 |
| Solana CLI | 3.1.10 |
| Surfpool | 1.5.0 |
| Rust | 1.89.0 (pinned in `onchain/rust-toolchain.toml`) |
| Node.js | 24.21.0 |
| Yarn | 1.22.22 |

Anchor 1.x is a major release with breaking changes relative to 0.3x.
Notably, the TypeScript package was renamed to `@anchor-lang/core`, and
Surfpool replaces the local validator for `anchor test`.

`avm` picks the Anchor CLI version from the `anchor-lang` version string
in `onchain/programs/openbounty/Cargo.toml`. That string is `"1.1.2"`,
which keeps the CLI at 1.1.2 while the lock file resolves the crate to
1.2.0. Run Anchor commands from `onchain/`.

## Onchain: Build, Test, Deploy

Prerequisites: Rust, Anchor CLI, Surfpool, Node.js and Yarn. Surfpool is
required, because `anchor test` uses it as the local validator. The
Solana CLI is needed for `solana program` and `solana-keygen` commands.

```bash
cd onchain
anchor build
anchor test        # local Surfpool only; about 1 minute
```

**Tests never run against devnet by accident.** `Anchor.toml` keeps the
provider on `localnet`, and the test suite refuses any non-local RPC
endpoint. The one exception is a devnet smoke test, which runs only when
`OPENBOUNTY_DEVNET=1` is set on purpose.

The Metaplex Core program is loaded into local tests from
`onchain/tests/fixtures/mpl_core.so` through `[[test.genesis]]` in
`Anchor.toml`, because `anchor test` runs Surfpool offline.

Upgrading devnet. The provider stays on `localnet`; the cluster is chosen
on the command line:

```bash
cd onchain
anchor build
solana program show 3xbu7yrMBpbhtzb5FqJgTydvEtPHBKWoQAQ5Vaw5nMCM --url devnet   # current data length
solana program extend 3xbu7yrMBpbhtzb5FqJgTydvEtPHBKWoQAQ5Vaw5nMCM <extra bytes> --url devnet
anchor deploy --provider.cluster devnet --no-idl -- --no-auto-extend
anchor idl upgrade --filepath target/idl/openbounty.json \
  3xbu7yrMBpbhtzb5FqJgTydvEtPHBKWoQAQ5Vaw5nMCM --provider.cluster devnet
```

- Extend only by the difference between the new `.so` size and the
  current data length.
- `--no-auto-extend` makes the deploy fail rather than spend more SOL
  without warning.
- The upgrade needs a temporary upload buffer worth the full program's
  rent, about 2.1 devnet SOL for the current 410 KB program. It is
  refunded when the upgrade completes.
- Anchor 1.1.2 warns that `anchor deploy` is deprecated in favour of
  `anchor program deploy`. The command above is the one that was used.

Smoke test against the deployed program:

```bash
cd onchain
OPENBOUNTY_DEVNET=1 \
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=$HOME/.config/solana/id.json \
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/openbounty.ts --grep "devnet smoke"
```

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
