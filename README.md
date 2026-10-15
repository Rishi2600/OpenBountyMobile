# OpenBounty Mobile

Trust-minimized on-chain escrow for bounties on Solana, as an Android app.
It covers any paid work, not only hackathons.

An organizer locks the full prize pool in an on-chain vault before
anyone starts work. Builders submit their entries on-chain. Judges vote
directly on-chain, each signing their own transaction, and a prize is
decided automatically once a strict majority of judges agrees. The winner
claims straight from the vault. The organizer can reclaim only prizes that
were never decided, or whose winner never claimed, and only after the
matching deadline.

**Program ID (devnet):** `3xbu7yrMBpbhtzb5FqJgTydvEtPHBKWoQAQ5Vaw5nMCM`

> **Status: being rebuilt (October 2026).**
>
> - This README describes the **target design (v3)**. It follows the
>   OpenBounty web version.
> - Devnet still runs the **previous v2 program** (SPL-token prizes and win
>   badges, deployed in slot 506727070) until the v3 upgrade lands. v2 and
>   v3 are not compatible.
> - The mobile app is not built yet.

## Relation to the Web Version

The OpenBounty web version
([repository](https://github.com/secur3shell-ship-it/OpenBounty),
[live](https://open-bounty-ten.vercel.app/)) is the benchmark for this
project:

- This program follows the web program's rules entirely, with one
  difference: an organizer can run an **unlimited** number of bounties
  (the web allows 256 per wallet).
- The mobile app offers the web app's features, adapted for phones.
- The two run on **separate programs**, so bounties made on one do not
  appear in the other.

## The Problem

People who post paid work, whether bounties, contests or hackathons,
promise prize money but don't always pay. Payments get delayed, disputed
or never sent, and participants have no way to check that the money
exists before they commit weeks of work.

## How It Works

1. **Lock.** The organizer creates a bounty with:
   - up to 4 prize tiers in SOL
   - up to 5 judges
   - three dates: when entries close, when judging ends, and a claim
     window of 1 to 90 days after judging

   The full prize pool moves into a program-controlled vault in the same
   transaction. Every bounty gets a new ID from the organizer's own
   counter, so a bounty's address is never reused.
2. **Enter.** Until entries close, any wallet except the organizer and the
   judges can submit one entry: a project name, a link and a short
   description.
3. **Judge.** Until judging ends, each judge signs their own
   `vote_winner` transaction naming a wallet for a prize tier. Votes are
   final. The vote that gives a candidate a strict majority of the judges
   decides the tier in the same transaction. In the app, judges can also
   keep private scorecards for each entry on their own phone.
4. **Claim.** The tier's winner claims straight from the vault, from the
   moment the tier is decided until the claim window ends. There is no
   approval step and no organizer involvement.
5. **Refund.** The organizer reclaims each prize separately:
   - a prize that never got a winner, after judging ends
   - a winner's unclaimed prize, after the claim window ends

   When every prize is claimed or refunded, the bounty account closes and
   its rent returns to the organizer.
6. **Close entry.** After judging ends, a builder can close their entry
   and get its rent back.

No role is stored as a flag anywhere. Organizer, judge and winner are
derived per bounty at the moment of each call. The program emits an event
for every state change.

## Trust Assumptions

**What the program guarantees** (v3, once deployed):

- **The prize pool is fully deposited before the bounty exists.**
  Creation fails unless the vault receives exactly the prize total.
- **The organizer cannot withdraw early.** Funds reach the organizer only
  by a refund:
  - an undecided prize, after judging ends
  - a decided prize, only after its claim window ends
- **The organizer cannot block a claim,** even by handing their wallet to
  another program.
- **Only the listed judges decide winners, by a strict majority.** So two
  winners for one prize are impossible. The organizer cannot be a judge,
  and a judge cannot be listed twice. Each judge votes at most once per
  tier.
- **Conflicts of interest are blocked.** A winner can never be the
  organizer or a judge. Neither the organizer nor a judge can submit an
  entry.
- **Only a tier's winner can claim it, and only once.**
- **Bounty addresses are never reused,** so a transaction built for one
  bounty can never affect another.

**What it does not guarantee:**

- **The code can still be changed.** The upgrade authority is a single
  wallet, `CCsJcqHJRLELykJ1GCTWvihUGFkFaP1eRws1MUAE6Ev6`, which could
  deploy new code, including code that moves escrowed funds. Moving it to
  a Squads multisig is planned but **not done yet**.
- **Judge independence.** The organizer chooses the judges. The program
  guarantees that a majority of the listed judges decides, not that the
  judges are independent.
- **Bounty details are untrusted.** The longer description is a JSON file
  the organizer hosts, linked from the bounty. It can change at any time
  and is shown as plain text. The on-chain title, judges and prizes are
  what count.

## Repository Layout

This is a single repository with two independent modules. They share no
code and no build tooling.

```
OpenBountyMobile/
├── onchain/     Anchor / Rust program (Solana devnet), the source of truth
├── offchain/    React Native (Expo) Android app (not created yet)
└── assets/      v2 win-badge metadata; removed after the v3 upgrade
```

The only coupling between the two modules is the deployed **program ID**
and the **IDL**. Every `anchor build` writes the IDL to
`onchain/idl/openbounty.json`, which is committed (from v3 on). The app
generates its typed client from that file.

## Stack

| Module | Stack |
|---|---|
| onchain | Anchor, Rust, Solana devnet |
| offchain | Expo (React Native, TypeScript), expo-router, `@solana/kit` with a Codama-generated client, Mobile Wallet Adapter. Prices come from CoinGecko and news from Solana RSS; there is no backend. |

## Toolchain

Built and tested against:

| Tool | Version |
|---|---|
| Anchor CLI | 1.1.2 |
| `anchor-lang` crate | 1.2.0 |
| Solana CLI | 3.1.10 |
| Surfpool | 1.5.0 |
| Rust | 1.89.0 (pinned in `onchain/rust-toolchain.toml`) |
| Node.js | 24.21.0 |
| Yarn (onchain) | 1.22.22 |

The app's Expo SDK version is pinned when the app is scaffolded.

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
anchor test        # local Surfpool only
```

**Tests never run against devnet by accident.** `Anchor.toml` keeps the
provider on `localnet`, and the test suite refuses any non-local RPC
endpoint. The one exception is a devnet smoke test, which runs only when
`OPENBOUNTY_DEVNET=1` is set on purpose. Tests cross deadlines with
Surfpool's time-travel cheatcode instead of waiting.

**Upgrading devnet.** The provider stays on `localnet`, and the cluster
is chosen on the command line:

```bash
cd onchain
anchor build
solana program show 3xbu7yrMBpbhtzb5FqJgTydvEtPHBKWoQAQ5Vaw5nMCM --url devnet   # current data length
# only if the new .so is larger than the current data length:
solana program extend 3xbu7yrMBpbhtzb5FqJgTydvEtPHBKWoQAQ5Vaw5nMCM <extra bytes> --url devnet
anchor deploy --provider.cluster devnet --no-idl -- --no-auto-extend
anchor idl upgrade --filepath target/idl/openbounty.json \
  3xbu7yrMBpbhtzb5FqJgTydvEtPHBKWoQAQ5Vaw5nMCM --provider.cluster devnet
```

- `--no-auto-extend` makes the deploy fail rather than spend more SOL
  without warning.
- The upgrade needs a temporary upload buffer worth the new program's
  rent. It is refunded when the upgrade completes.
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

## Offchain: Run the Mobile App

Prerequisites:
- Node.js
- JDK 17 and the Android SDK
- an Android device or emulator, with Phantom or Solflare installed and
  set to devnet

The app uses Mobile Wallet Adapter, so it needs an Expo **development
build**; Expo Go does not work.

```bash
# TODO: filled in when the app is scaffolded
```

iOS is planned for later. It needs a different wallet connection, because
Mobile Wallet Adapter is Android-only.

## Roadmap

| Step | Status |
|---|---|
| v3 program, matching the web program, with unlimited bounties | planned |
| v3 upgrade on devnet | planned |
| Android app: Explore, bounty page (prizes, entries, judging), create, your bounties, markets | planned |
| End-to-end devnet run and release APK | planned |
| Upgrade authority moved to a Squads multisig | parked |
| iOS wallet support | parked |
| Token prizes, past bounties, claim in any token (web roadmap) | later |

## Demo

TODO: demo video link.

## License

TODO
