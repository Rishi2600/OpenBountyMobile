import * as anchor from "@anchor-lang/core";
import { BN, Program, web3 } from "@anchor-lang/core";
import { expect } from "chai";
import { Openbounty } from "../target/types/openbounty";

// ---------------------------------------------------------------------------
// Shared setup and helpers
// ---------------------------------------------------------------------------

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.openbounty as Program<Openbounty>;
const connection = provider.connection;

// Every transaction waits for "confirmed" so that the next step (a balance
// read, a fee lookup, or a transaction from a freshly funded wallet) always
// sees its result.
const CONFIRM: web3.ConfirmOptions = {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
};

const ONE_HOUR = 60 * 60;

// Funding for wallets that only sign and pay fees, such as judges. It covers
// the rent-exempt minimum a wallet must keep (about 0.0009 SOL) plus fees,
// and is far smaller than any prize used in these tests.
const FEE_LAMPORTS = 5_000_000;

// Moves SOL from the provider wallet to a test wallet. Tests never rely on
// airdrops.
async function fund(to: web3.PublicKey, lamports: number) {
  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: to,
      lamports,
    })
  );
  await provider.sendAndConfirm(tx, [], CONFIRM);
}

// A client for the program where `signer` signs and pays the fee, the same
// way each user pays for their own transactions in the mobile app.
function programFor(signer: web3.Keypair): Program<Openbounty> {
  const signerProvider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(signer),
    CONFIRM
  );
  return new Program<Openbounty>(program.idl, signerProvider);
}

function escrowPda(
  organizer: web3.PublicKey,
  nonce: number
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), organizer.toBuffer(), Buffer.from([nonce])],
    program.programId
  );
}

function vaultPda(
  organizer: web3.PublicKey,
  nonce: number
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), organizer.toBuffer(), Buffer.from([nonce])],
    program.programId
  );
}

// The program checks deadlines against the on-chain clock, which can differ
// from this machine's clock, so tests read the same Clock sysvar the program
// reads. unix_timestamp is the i64 at byte offset 32.
async function chainNow(): Promise<number> {
  const clock = await connection.getAccountInfo(web3.SYSVAR_CLOCK_PUBKEY);
  if (clock === null) {
    throw new Error("Clock sysvar not found");
  }
  return Number(clock.data.readBigInt64LE(32));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits until the on-chain clock is strictly past `timestamp`. Gives up after
// about a minute so a stalled clock fails the test instead of hanging it.
async function waitUntilAfter(timestamp: number) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await chainNow()) > timestamp) {
      return;
    }
    await sleep(500);
  }
  throw new Error("On-chain clock never passed " + timestamp);
}

// A public RPC node (such as devnet's) can take a moment to serve a
// transaction it has just confirmed, so this retries briefly before failing.
async function txFee(signature: string): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx !== null && tx.meta !== null) {
      return tx.meta.fee;
    }
    await sleep(500);
  }
  throw new Error("Transaction not found: " + signature);
}

// Asserts that `action` fails with the named program error, for example
// "InvalidTitleLength". On a mismatch the raw error is shown.
async function expectError(action: Promise<unknown>, code: string) {
  let caught: unknown = null;
  try {
    await action;
  } catch (err) {
    caught = err;
  }
  if (caught === null) {
    expect.fail("Expected the transaction to fail with " + code);
  }
  if (caught instanceof anchor.AnchorError) {
    expect(caught.error.errorCode.code).to.equal(code);
  } else {
    expect(String(caught)).to.equal(code);
  }
}

type BountyOptions = {
  judges: web3.PublicKey[];
  title?: string;
  metadataUri?: string;
  threshold?: number;
  tierAmounts?: number[];
  deadline?: number;
  nonce?: number;
};

// Creates a bounty signed and paid for by `organizer`. Anything not given in
// `options` gets a valid default: one 0.1 SOL tier, threshold 1, a deadline
// one hour away, nonce 0.
async function createBounty(organizer: web3.Keypair, options: BountyOptions) {
  const title = options.title ?? "Test Bounty";
  const metadataUri = options.metadataUri ?? "";
  const threshold = options.threshold ?? 1;
  const tierAmounts = options.tierAmounts ?? [100_000_000];
  const nonce = options.nonce ?? 0;

  let deadline = options.deadline;
  if (deadline === undefined) {
    deadline = (await chainNow()) + ONE_HOUR;
  }

  const [escrow] = escrowPda(organizer.publicKey, nonce);
  const [vault] = vaultPda(organizer.publicKey, nonce);

  const amounts: BN[] = [];
  for (const amount of tierAmounts) {
    amounts.push(new BN(amount));
  }

  const signature = await programFor(organizer)
    .methods.initializeEscrow(
      title,
      metadataUri,
      options.judges,
      threshold,
      amounts,
      new BN(deadline),
      nonce
    )
    .accountsPartial({
      escrow,
      vault,
      organizer: organizer.publicKey,
    })
    .rpc();

  return { escrow, vault, signature };
}

// Casts one vote, signed and paid for by the judge.
async function castVote(
  judge: web3.Keypair,
  escrow: web3.PublicKey,
  nonce: number,
  tier: number,
  candidate: web3.PublicKey
) {
  return programFor(judge)
    .methods.voteWinner(nonce, tier, candidate)
    .accountsPartial({ escrow, judge: judge.publicKey })
    .rpc();
}

// Claims one tier, signed and paid for by `winner`. The escrow and vault are
// derived from the organizer's key and the nonce.
async function claimPrize(
  winner: web3.Keypair,
  organizer: web3.PublicKey,
  nonce: number,
  tier: number
) {
  const [escrow] = escrowPda(organizer, nonce);
  const [vault] = vaultPda(organizer, nonce);
  return programFor(winner)
    .methods.claimPrize(nonce, tier)
    .accountsPartial({
      escrow,
      vault,
      winner: winner.publicKey,
      organizer,
    })
    .rpc();
}

// Asks for a refund, signed and paid for by `signer`. The escrow and vault are
// derived from the real organizer's key, while `signer` is passed as the
// organizer account, so a test can have someone else attempt the refund.
async function refundUnclaimed(
  signer: web3.Keypair,
  organizer: web3.PublicKey,
  nonce: number
) {
  const [escrow] = escrowPda(organizer, nonce);
  const [vault] = vaultPda(organizer, nonce);
  return programFor(signer)
    .methods.refundUnclaimed(nonce)
    .accountsPartial({
      escrow,
      vault,
      organizer: signer.publicKey,
    })
    .rpc();
}

// ---------------------------------------------------------------------------
// initialize_escrow
// ---------------------------------------------------------------------------

describe("initialize_escrow", () => {
  const organizer = web3.Keypair.generate();
  const judges = [
    web3.Keypair.generate().publicKey,
    web3.Keypair.generate().publicKey,
    web3.Keypair.generate().publicKey,
  ];

  // Signs every failure test. The escrow account is created by Anchor before
  // the handler runs its checks, so this wallet must cover the escrow's rent
  // (about 0.014 SOL) and fees. It holds far less than the 0.1 SOL default
  // prize, so a check that failed to fire would surface as a transfer error
  // instead of the expected program error.
  const underfundedOrganizer = web3.Keypair.generate();
  const UNDERFUNDED_LAMPORTS = 30_000_000;

  before(async () => {
    await fund(organizer.publicKey, 2 * web3.LAMPORTS_PER_SOL);
    await fund(underfundedOrganizer.publicKey, UNDERFUNDED_LAMPORTS);
  });

  // None of the failure tests succeed, so the underfunded organizer's escrow
  // at the default nonce 0 must still not exist afterwards.
  async function expectCreateToFail(options: BountyOptions, code: string) {
    await expectError(createBounty(underfundedOrganizer, options), code);
    const [escrow] = escrowPda(underfundedOrganizer.publicKey, 0);
    expect(await connection.getAccountInfo(escrow)).to.equal(null);
  }

  it("creates a bounty and locks the prize pool", async () => {
    // 0.5 SOL and 0.3 SOL
    const tierAmounts = [500_000_000, 300_000_000];
    const prizeTotal = 800_000_000;
    const deadline = (await chainNow()) + ONE_HOUR;
    const organizerBefore = await connection.getBalance(organizer.publicKey);

    const { escrow, vault, signature } = await createBounty(organizer, {
      title: "Solana Summer Hackathon",
      metadataUri: "https://example.com/bounty.json",
      judges,
      threshold: 2,
      tierAmounts,
      deadline,
      nonce: 0,
    });

    const account = await program.account.escrow.fetch(escrow);
    const [, escrowBump] = escrowPda(organizer.publicKey, 0);
    const [, vaultBump] = vaultPda(organizer.publicKey, 0);

    expect(account.organizer.toBase58()).to.equal(
      organizer.publicKey.toBase58()
    );
    expect(account.title).to.equal("Solana Summer Hackathon");
    expect(account.metadataUri).to.equal("https://example.com/bounty.json");
    expect(account.judges.length).to.equal(judges.length);
    for (let i = 0; i < judges.length; i++) {
      expect(account.judges[i].toBase58()).to.equal(judges[i].toBase58());
    }
    expect(account.threshold).to.equal(2);
    expect(account.deadline.toNumber()).to.equal(deadline);
    expect(account.nonce).to.equal(0);
    expect(account.bump).to.equal(escrowBump);
    expect(account.vaultBump).to.equal(vaultBump);

    expect(account.tiers.length).to.equal(tierAmounts.length);
    for (let i = 0; i < tierAmounts.length; i++) {
      const tier = account.tiers[i];
      expect(tier.amount.toNumber()).to.equal(tierAmounts[i]);
      expect(tier.winner).to.equal(null);
      expect(tier.claimed).to.equal(false);
      expect(tier.votes.length).to.equal(0);
    }

    // The vault holds the whole prize pool plus its own rent-exempt minimum.
    const vaultRent = await connection.getMinimumBalanceForRentExemption(0);
    expect(await connection.getBalance(vault)).to.equal(prizeTotal + vaultRent);

    // The organizer paid for exactly the prize pool, both accounts' rent, and
    // the transaction fee, and nothing else.
    const escrowRent = await connection.getBalance(escrow);
    const fee = await txFee(signature);
    const organizerAfter = await connection.getBalance(organizer.publicKey);
    expect(organizerBefore - organizerAfter).to.equal(
      prizeTotal + vaultRent + escrowRent + fee
    );
  });

  it("lets one organizer run more bounties under different nonces", async () => {
    const first = await createBounty(organizer, {
      judges,
      title: "First Bounty",
      tierAmounts: [100_000_000],
      nonce: 1,
    });
    const second = await createBounty(organizer, {
      judges,
      title: "Second Bounty",
      tierAmounts: [200_000_000],
      nonce: 2,
    });

    expect(first.escrow.toBase58()).to.not.equal(second.escrow.toBase58());
    expect(first.vault.toBase58()).to.not.equal(second.vault.toBase58());

    const firstAccount = await program.account.escrow.fetch(first.escrow);
    expect(firstAccount.title).to.equal("First Bounty");
    expect(firstAccount.nonce).to.equal(1);
    expect(firstAccount.tiers[0].amount.toNumber()).to.equal(100_000_000);

    const secondAccount = await program.account.escrow.fetch(second.escrow);
    expect(secondAccount.title).to.equal("Second Bounty");
    expect(secondAccount.nonce).to.equal(2);
    expect(secondAccount.tiers[0].amount.toNumber()).to.equal(200_000_000);

    // Each vault holds only its own bounty's prize pool.
    const vaultRent = await connection.getMinimumBalanceForRentExemption(0);
    expect(await connection.getBalance(first.vault)).to.equal(
      100_000_000 + vaultRent
    );
    expect(await connection.getBalance(second.vault)).to.equal(
      200_000_000 + vaultRent
    );
  });

  it("rejects an empty title", async () => {
    await expectCreateToFail({ judges, title: "" }, "InvalidTitleLength");
  });

  it("rejects a 51-byte title", async () => {
    await expectCreateToFail(
      { judges, title: "a".repeat(51) },
      "InvalidTitleLength"
    );
  });

  it("rejects a 101-byte metadata URI", async () => {
    await expectCreateToFail(
      { judges, metadataUri: "a".repeat(101) },
      "InvalidMetadataUriLength"
    );
  });

  it("rejects a threshold above the number of judges", async () => {
    await expectCreateToFail({ judges, threshold: 4 }, "InvalidThreshold");
  });

  it("rejects a threshold of zero", async () => {
    await expectCreateToFail({ judges, threshold: 0 }, "InvalidThreshold");
  });

  it("rejects a deadline in the past", async () => {
    const deadline = (await chainNow()) - 60;
    await expectCreateToFail({ judges, deadline }, "InvalidDeadline");
  });

  it("rejects an empty judges list", async () => {
    await expectCreateToFail({ judges: [] }, "NoJudges");
  });

  it("rejects a prize tier with a zero amount", async () => {
    await expectCreateToFail(
      { judges, tierAmounts: [100_000_000, 0] },
      "InvalidAmount"
    );
  });
});

// ---------------------------------------------------------------------------
// vote_winner
// ---------------------------------------------------------------------------

describe("vote_winner", () => {
  const organizer = web3.Keypair.generate();
  const judges = [
    web3.Keypair.generate(),
    web3.Keypair.generate(),
    web3.Keypair.generate(),
  ];
  const judgeKeys = [
    judges[0].publicKey,
    judges[1].publicKey,
    judges[2].publicKey,
  ];

  // Candidates only receive votes, so they never need funding.
  const candidateA = web3.Keypair.generate().publicKey;
  const candidateB = web3.Keypair.generate().publicKey;
  const candidateC = web3.Keypair.generate().publicKey;

  // A wallet that is not on any judge list.
  const outsider = web3.Keypair.generate();

  before(async () => {
    await fund(organizer.publicKey, 2 * web3.LAMPORTS_PER_SOL);
    for (const judge of judges) {
      await fund(judge.publicKey, FEE_LAMPORTS);
    }
    await fund(outsider.publicKey, FEE_LAMPORTS);
  });

  it("records a single vote without choosing a winner", async () => {
    const nonce = 0;
    const { escrow } = await createBounty(organizer, {
      judges: judgeKeys,
      threshold: 2,
      nonce,
    });

    await castVote(judges[0], escrow, nonce, 0, candidateA);

    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(1);
    expect(tier.votes[0].judge.toBase58()).to.equal(
      judges[0].publicKey.toBase58()
    );
    expect(tier.votes[0].candidate.toBase58()).to.equal(candidateA.toBase58());
    expect(tier.winner).to.equal(null);
    expect(tier.claimed).to.equal(false);
  });

  it("finalizes the tier when a candidate reaches the threshold", async () => {
    const nonce = 1;
    const { escrow, vault } = await createBounty(organizer, {
      judges: judgeKeys,
      threshold: 2,
      nonce,
    });
    const vaultBefore = await connection.getBalance(vault);

    await castVote(judges[0], escrow, nonce, 0, candidateA);
    let tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.winner).to.equal(null);

    await castVote(judges[1], escrow, nonce, 0, candidateA);
    tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(2);
    expect(tier.winner?.toBase58()).to.equal(candidateA.toBase58());
    expect(tier.claimed).to.equal(false);

    // Finalizing only records the winner. The prize stays in the vault until
    // the winner claims it.
    expect(await connection.getBalance(vault)).to.equal(vaultBefore);
  });

  it("leaves the tier open when the votes are split", async () => {
    const nonce = 2;
    const { escrow } = await createBounty(organizer, {
      judges: judgeKeys,
      threshold: 2,
      nonce,
    });

    await castVote(judges[0], escrow, nonce, 0, candidateA);
    await castVote(judges[1], escrow, nonce, 0, candidateB);
    await castVote(judges[2], escrow, nonce, 0, candidateC);

    // Every judge has voted and no candidate has two votes, so the tier can
    // never finalize.
    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(3);
    expect(tier.winner).to.equal(null);
  });

  it("finalizes two tiers independently", async () => {
    const nonce = 3;
    const { escrow } = await createBounty(organizer, {
      judges: judgeKeys,
      threshold: 2,
      tierAmounts: [300_000_000, 100_000_000],
      nonce,
    });

    await castVote(judges[0], escrow, nonce, 0, candidateA);
    await castVote(judges[1], escrow, nonce, 0, candidateA);

    // Tier 0 is decided, and tier 1 has not been touched.
    let account = await program.account.escrow.fetch(escrow);
    expect(account.tiers[0].winner?.toBase58()).to.equal(candidateA.toBase58());
    expect(account.tiers[1].winner).to.equal(null);
    expect(account.tiers[1].votes.length).to.equal(0);

    // Judge 0 already voted on tier 0, and may still vote on tier 1.
    await castVote(judges[0], escrow, nonce, 1, candidateB);
    await castVote(judges[2], escrow, nonce, 1, candidateB);

    account = await program.account.escrow.fetch(escrow);
    expect(account.tiers[0].winner?.toBase58()).to.equal(candidateA.toBase58());
    expect(account.tiers[0].votes.length).to.equal(2);
    expect(account.tiers[1].winner?.toBase58()).to.equal(candidateB.toBase58());
    expect(account.tiers[1].votes.length).to.equal(2);
  });

  it("rejects a vote from someone who is not a judge", async () => {
    const nonce = 4;
    const { escrow } = await createBounty(organizer, {
      judges: judgeKeys,
      nonce,
    });

    await expectError(
      castVote(outsider, escrow, nonce, 0, candidateA),
      "NotAJudge"
    );

    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(0);
    expect(tier.winner).to.equal(null);
  });

  it("rejects a second vote from the same judge on the same tier", async () => {
    const nonce = 5;
    const { escrow } = await createBounty(organizer, {
      judges: judgeKeys,
      threshold: 2,
      nonce,
    });

    await castVote(judges[0], escrow, nonce, 0, candidateA);
    await expectError(
      castVote(judges[0], escrow, nonce, 0, candidateA),
      "AlreadyVoted"
    );

    // Only the first vote counts, so candidate A is still one vote short.
    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(1);
    expect(tier.winner).to.equal(null);
  });

  it("rejects a vote on a tier that already has a winner", async () => {
    const nonce = 6;
    const { escrow } = await createBounty(organizer, {
      judges: judgeKeys,
      threshold: 2,
      nonce,
    });

    await castVote(judges[0], escrow, nonce, 0, candidateA);
    await castVote(judges[1], escrow, nonce, 0, candidateA);
    await expectError(
      castVote(judges[2], escrow, nonce, 0, candidateB),
      "TierAlreadyFinalized"
    );

    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(2);
    expect(tier.winner?.toBase58()).to.equal(candidateA.toBase58());
  });

  it("rejects a vote on a tier that does not exist", async () => {
    const nonce = 7;
    const { escrow } = await createBounty(organizer, {
      judges: judgeKeys,
      nonce,
    });

    // The bounty has a single tier, at index 0.
    await expectError(
      castVote(judges[0], escrow, nonce, 1, candidateA),
      "InvalidTierIndex"
    );

    const account = await program.account.escrow.fetch(escrow);
    expect(account.tiers.length).to.equal(1);
    expect(account.tiers[0].votes.length).to.equal(0);
  });

  it("rejects a vote after the deadline", async () => {
    const nonce = 8;
    // Just far enough ahead for the creation transaction to land first.
    const deadline = (await chainNow()) + 3;
    const { escrow } = await createBounty(organizer, {
      judges: judgeKeys,
      deadline,
      nonce,
    });

    await waitUntilAfter(deadline);
    await expectError(
      castVote(judges[0], escrow, nonce, 0, candidateA),
      "DeadlinePassed"
    );

    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(0);
    expect(tier.winner).to.equal(null);
  });
});

// ---------------------------------------------------------------------------
// claim_prize
// ---------------------------------------------------------------------------

describe("claim_prize", () => {
  const organizer = web3.Keypair.generate();
  const judge = web3.Keypair.generate();
  const winner = web3.Keypair.generate();
  const outsider = web3.Keypair.generate();

  before(async () => {
    // Five bounties at about 0.415 SOL each (prize, both rents, fee).
    await fund(organizer.publicKey, 3 * web3.LAMPORTS_PER_SOL);
    await fund(judge.publicKey, FEE_LAMPORTS);
    await fund(winner.publicKey, FEE_LAMPORTS);
    await fund(outsider.publicKey, FEE_LAMPORTS);
  });

  // Every bounty here has two tiers. Only the last test claims both; the
  // others claim at most one, so they never reach the final claim that closes
  // the accounts.
  async function createTwoTierBounty(nonce: number) {
    return createBounty(organizer, {
      judges: [judge.publicKey],
      threshold: 1,
      tierAmounts: [300_000_000, 100_000_000],
      nonce,
    });
  }

  it("pays the winner and marks the tier claimed", async () => {
    const nonce = 0;
    const { escrow, vault } = await createTwoTierBounty(nonce);
    await castVote(judge, escrow, nonce, 0, winner.publicKey);

    const winnerBefore = await connection.getBalance(winner.publicKey);
    const vaultBefore = await connection.getBalance(vault);

    const signature = await claimPrize(winner, organizer.publicKey, nonce, 0);

    // The winner receives the full tier amount and pays only their own fee.
    const fee = await txFee(signature);
    const winnerAfter = await connection.getBalance(winner.publicKey);
    expect(winnerAfter - winnerBefore).to.equal(300_000_000 - fee);
    expect(await connection.getBalance(vault)).to.equal(
      vaultBefore - 300_000_000
    );

    const account = await program.account.escrow.fetch(escrow);
    expect(account.tiers[0].claimed).to.equal(true);
    expect(account.tiers[1].claimed).to.equal(false);
  });

  it("rejects a claim from someone who is not the winner", async () => {
    const nonce = 1;
    const { escrow, vault } = await createTwoTierBounty(nonce);
    await castVote(judge, escrow, nonce, 0, winner.publicKey);
    const vaultBefore = await connection.getBalance(vault);

    await expectError(
      claimPrize(outsider, organizer.publicKey, nonce, 0),
      "NotWinner"
    );

    expect(await connection.getBalance(vault)).to.equal(vaultBefore);
    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.claimed).to.equal(false);
  });

  it("rejects a second claim of the same tier", async () => {
    const nonce = 2;
    const { escrow, vault } = await createTwoTierBounty(nonce);
    await castVote(judge, escrow, nonce, 0, winner.publicKey);
    await claimPrize(winner, organizer.publicKey, nonce, 0);
    const vaultAfterFirstClaim = await connection.getBalance(vault);

    await expectError(
      claimPrize(winner, organizer.publicKey, nonce, 0),
      "TierAlreadyClaimed"
    );

    expect(await connection.getBalance(vault)).to.equal(vaultAfterFirstClaim);
  });

  it("rejects a claim before the tier has a winner", async () => {
    const nonce = 3;
    const { escrow, vault } = await createTwoTierBounty(nonce);
    const vaultBefore = await connection.getBalance(vault);

    await expectError(
      claimPrize(winner, organizer.publicKey, nonce, 0),
      "TierNotFinalized"
    );

    expect(await connection.getBalance(vault)).to.equal(vaultBefore);
    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.winner).to.equal(null);
    expect(tier.claimed).to.equal(false);
  });

  it("closes both accounts on the final claim and refunds their rent to the organizer", async () => {
    const nonce = 4;
    const { escrow, vault } = await createTwoTierBounty(nonce);
    await castVote(judge, escrow, nonce, 0, winner.publicKey);
    await castVote(judge, escrow, nonce, 1, winner.publicKey);
    await claimPrize(winner, organizer.publicKey, nonce, 0);

    // Before the final claim the vault holds tier 1's prize and its own rent.
    const vaultRent = await connection.getMinimumBalanceForRentExemption(0);
    expect(await connection.getBalance(vault)).to.equal(
      100_000_000 + vaultRent
    );
    const escrowRent = await connection.getBalance(escrow);
    const organizerBefore = await connection.getBalance(organizer.publicKey);
    const winnerBefore = await connection.getBalance(winner.publicKey);

    const signature = await claimPrize(winner, organizer.publicKey, nonce, 1);

    expect(await connection.getAccountInfo(escrow)).to.equal(null);
    expect(await connection.getAccountInfo(vault)).to.equal(null);

    // The winner gets tier 1's prize minus their fee. The organizer signed
    // nothing, and receives exactly the rent that kept both accounts alive.
    const fee = await txFee(signature);
    const winnerAfter = await connection.getBalance(winner.publicKey);
    expect(winnerAfter - winnerBefore).to.equal(100_000_000 - fee);
    const organizerAfter = await connection.getBalance(organizer.publicKey);
    expect(organizerAfter - organizerBefore).to.equal(escrowRent + vaultRent);
  });
});

// ---------------------------------------------------------------------------
// refund_unclaimed
// ---------------------------------------------------------------------------

describe("refund_unclaimed", () => {
  const organizer = web3.Keypair.generate();
  const judge = web3.Keypair.generate();
  const winner = web3.Keypair.generate();
  const outsider = web3.Keypair.generate();

  // Long enough for a bounty to be created, voted on and claimed before it
  // expires. Tests then wait it out on the on-chain clock.
  const SHORT_DEADLINE_SECONDS = 8;

  before(async () => {
    // Five bounties, with at most about 1.2 SOL locked before any refund.
    await fund(organizer.publicKey, 2 * web3.LAMPORTS_PER_SOL);
    await fund(judge.publicKey, FEE_LAMPORTS);
    await fund(winner.publicKey, FEE_LAMPORTS);
    await fund(outsider.publicKey, FEE_LAMPORTS);
  });

  // Two tiers of 0.3 SOL and 0.1 SOL, with one judge whose single vote decides
  // a tier.
  async function createTwoTierBounty(nonce: number, deadline?: number) {
    return createBounty(organizer, {
      judges: [judge.publicKey],
      threshold: 1,
      tierAmounts: [300_000_000, 100_000_000],
      deadline,
      nonce,
    });
  }

  it("refunds every unclaimed tier after the deadline and closes both accounts", async () => {
    const nonce = 0;
    const deadline = (await chainNow()) + SHORT_DEADLINE_SECONDS;
    const { escrow, vault } = await createTwoTierBounty(nonce, deadline);

    // Tier 0 gets a winner who never claims. Tier 1 never gets a winner.
    // Both count as unclaimed.
    await castVote(judge, escrow, nonce, 0, winner.publicKey);
    await waitUntilAfter(deadline);

    const vaultRent = await connection.getMinimumBalanceForRentExemption(0);
    expect(await connection.getBalance(vault)).to.equal(
      400_000_000 + vaultRent
    );
    const escrowRent = await connection.getBalance(escrow);
    const organizerBefore = await connection.getBalance(organizer.publicKey);

    const signature = await refundUnclaimed(
      organizer,
      organizer.publicKey,
      nonce
    );

    expect(await connection.getAccountInfo(escrow)).to.equal(null);
    expect(await connection.getAccountInfo(vault)).to.equal(null);

    // The organizer gets back the whole 0.4 SOL pool plus both accounts' rent,
    // less the fee for this transaction.
    const fee = await txFee(signature);
    const organizerAfter = await connection.getBalance(organizer.publicKey);
    const refundedPrizes =
      organizerAfter - organizerBefore + fee - vaultRent - escrowRent;
    expect(refundedPrizes).to.equal(400_000_000);
  });

  it("rejects a refund before the deadline", async () => {
    const nonce = 1;
    const { escrow, vault } = await createBounty(organizer, {
      judges: [judge.publicKey],
      nonce,
    });
    const vaultBefore = await connection.getBalance(vault);

    await expectError(
      refundUnclaimed(organizer, organizer.publicKey, nonce),
      "DeadlineNotPassed"
    );

    expect(await connection.getBalance(vault)).to.equal(vaultBefore);
    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.claimed).to.equal(false);
  });

  it("rejects a refund from someone who is not the organizer", async () => {
    const nonce = 2;
    const deadline = (await chainNow()) + SHORT_DEADLINE_SECONDS;
    const { escrow, vault } = await createBounty(organizer, {
      judges: [judge.publicKey],
      deadline,
      nonce,
    });

    // Past the deadline a refund is allowed, so the signer is the only thing
    // wrong with this attempt.
    await waitUntilAfter(deadline);
    const vaultBefore = await connection.getBalance(vault);

    await expectError(
      refundUnclaimed(outsider, organizer.publicKey, nonce),
      "Unauthorized"
    );

    expect(await connection.getBalance(vault)).to.equal(vaultBefore);
    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.claimed).to.equal(false);
  });

  it("rejects a refund once every tier has been claimed", async () => {
    const nonce = 3;
    const deadline = (await chainNow()) + SHORT_DEADLINE_SECONDS;
    const { escrow, vault } = await createBounty(organizer, {
      judges: [judge.publicKey],
      deadline,
      nonce,
    });
    await castVote(judge, escrow, nonce, 0, winner.publicKey);
    await claimPrize(winner, organizer.publicKey, nonce, 0);
    await waitUntilAfter(deadline);

    // The final claim already closed the escrow, so there is no account left
    // to refund from. Anchor rejects the missing account before the program's
    // own NoUnclaimedFunds check can run.
    const organizerBefore = await connection.getBalance(organizer.publicKey);
    await expectError(
      refundUnclaimed(organizer, organizer.publicKey, nonce),
      "AccountNotInitialized"
    );

    expect(await connection.getAccountInfo(escrow)).to.equal(null);
    expect(await connection.getAccountInfo(vault)).to.equal(null);
    expect(await connection.getBalance(organizer.publicKey)).to.equal(
      organizerBefore
    );
  });

  it("refunds only the unclaimed tiers when some were already claimed", async () => {
    const nonce = 4;
    const deadline = (await chainNow()) + SHORT_DEADLINE_SECONDS;
    const { escrow, vault } = await createTwoTierBounty(nonce, deadline);

    // Tier 0 (0.3 SOL) is won and claimed. Tier 1 (0.1 SOL) never gets a
    // winner.
    await castVote(judge, escrow, nonce, 0, winner.publicKey);
    await claimPrize(winner, organizer.publicKey, nonce, 0);
    await waitUntilAfter(deadline);

    const vaultRent = await connection.getMinimumBalanceForRentExemption(0);
    const escrowRent = await connection.getBalance(escrow);
    const organizerBefore = await connection.getBalance(organizer.publicKey);

    const signature = await refundUnclaimed(
      organizer,
      organizer.publicKey,
      nonce
    );

    expect(await connection.getAccountInfo(escrow)).to.equal(null);
    expect(await connection.getAccountInfo(vault)).to.equal(null);

    // Only tier 1's 0.1 SOL comes back, not the original 0.4 SOL pool.
    const fee = await txFee(signature);
    const organizerAfter = await connection.getBalance(organizer.publicKey);
    const refundedPrizes =
      organizerAfter - organizerBefore + fee - vaultRent - escrowRent;
    expect(refundedPrizes).to.equal(100_000_000);
  });
});

// ---------------------------------------------------------------------------
// devnet smoke
// ---------------------------------------------------------------------------

// One full lifecycle against a real cluster: create, vote to finalize, claim.
// It runs with the local suite, and on its own against devnet with:
//
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=$HOME/.config/solana/id.json \
//   yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/openbounty.ts \
//     --grep "devnet smoke"
//
// It uses a small prize to save devnet SOL, and reads at "confirmed" so a
// public RPC node that lags slightly behind cannot fail it.
describe("devnet smoke", () => {
  const organizer = web3.Keypair.generate();
  const judges = [web3.Keypair.generate(), web3.Keypair.generate()];
  const winner = web3.Keypair.generate();

  // 0.05 SOL
  const PRIZE = 50_000_000;

  before(async () => {
    // The prize, both accounts' rent (about 0.015 SOL), and fees.
    await fund(organizer.publicKey, 100_000_000);
    for (const judge of judges) {
      await fund(judge.publicKey, FEE_LAMPORTS);
    }
    await fund(winner.publicKey, FEE_LAMPORTS);
  });

  it("creates a bounty, finalizes a tier by vote, and pays the winner", async () => {
    const nonce = 0;
    const created = await createBounty(organizer, {
      title: "OpenBounty Smoke Test",
      judges: [judges[0].publicKey, judges[1].publicKey],
      threshold: 2,
      tierAmounts: [PRIZE],
      nonce,
    });
    const escrow = created.escrow;
    const vault = created.vault;

    const firstVote = await castVote(
      judges[0],
      escrow,
      nonce,
      0,
      winner.publicKey
    );
    const secondVote = await castVote(
      judges[1],
      escrow,
      nonce,
      0,
      winner.publicKey
    );

    const account = await program.account.escrow.fetch(escrow, "confirmed");
    expect(account.tiers[0].winner?.toBase58()).to.equal(
      winner.publicKey.toBase58()
    );

    const winnerBefore = await connection.getBalance(
      winner.publicKey,
      "confirmed"
    );
    const claim = await claimPrize(winner, organizer.publicKey, nonce, 0);

    // The winner is paid the prize, and because this was the only tier the
    // claim also closed both accounts.
    const fee = await txFee(claim);
    const winnerAfter = await connection.getBalance(
      winner.publicKey,
      "confirmed"
    );
    expect(winnerAfter - winnerBefore).to.equal(PRIZE - fee);
    expect(await connection.getAccountInfo(escrow, "confirmed")).to.equal(null);
    expect(await connection.getAccountInfo(vault, "confirmed")).to.equal(null);

    console.log("      organizer:     " + organizer.publicKey.toBase58());
    console.log("      escrow:        " + escrow.toBase58());
    console.log("      vault:         " + vault.toBase58());
    console.log("      winner:        " + winner.publicKey.toBase58());
    console.log("      create bounty: " + created.signature);
    console.log("      first vote:    " + firstVote);
    console.log("      second vote:   " + secondVote);
    console.log("      claim prize:   " + claim);
  });
});
