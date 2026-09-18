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

  before(async () => {
    await fund(organizer.publicKey, 2 * web3.LAMPORTS_PER_SOL);
  });

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
});
