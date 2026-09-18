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

async function txFee(signature: string): Promise<number> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (tx === null || tx.meta === null) {
    throw new Error("Transaction not found: " + signature);
  }
  return tx.meta.fee;
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

  before(async () => {
    await fund(organizer.publicKey, web3.LAMPORTS_PER_SOL);
    for (const judge of judges) {
      await fund(judge.publicKey, FEE_LAMPORTS);
    }
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
});
