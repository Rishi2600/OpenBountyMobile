import * as anchor from "@anchor-lang/core";
import { BN, Program, web3 } from "@anchor-lang/core";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import { Openbounty } from "../target/types/openbounty";

// ---------------------------------------------------------------------------
// Shared setup and helpers
// ---------------------------------------------------------------------------

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.openbounty as Program<Openbounty>;
const connection = provider.connection;

// Tests only ever run against a local validator. The single exception is the
// devnet block, which runs only when OPENBOUNTY_DEVNET=1 is set on purpose.
// Without that flag a non-local endpoint stops the run here, before any
// transaction is sent.
const RUN_DEVNET = process.env.OPENBOUNTY_DEVNET === "1";

function isLocalEndpoint(endpoint: string): boolean {
  const host = new URL(endpoint).hostname;
  if (host === "127.0.0.1") {
    return true;
  }
  if (host === "localhost") {
    return true;
  }
  return false;
}

if (!RUN_DEVNET && !isLocalEndpoint(connection.rpcEndpoint)) {
  throw new Error(
    "Refusing to run tests against " +
      connection.rpcEndpoint +
      ". Tests run only on a local validator."
  );
}

// With OPENBOUNTY_DEVNET=1 only the devnet block runs, and without it only the
// local blocks run, so the local suite can never send transactions to devnet.
function describeLocal(name: string, body: () => void) {
  if (RUN_DEVNET) {
    describe.skip(name, body);
    return;
  }
  describe(name, body);
}

function describeDevnet(name: string, body: () => void) {
  if (RUN_DEVNET) {
    describe(name, body);
    return;
  }
  describe.skip(name, body);
}

// Every transaction waits for "confirmed" so that the next step (a balance
// read, a fee lookup, or a transaction from a freshly funded wallet) always
// sees its result.
const CONFIRM: web3.ConfirmOptions = {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
};

const ONE_HOUR = 60 * 60;

// Must match MIN_CLAIM_WINDOW in the program: seven days, in seconds.
const MIN_CLAIM_WINDOW = 7 * 24 * 60 * 60;

// Test mints use 6 decimals, like USDC, so one token is 1,000,000 base units.
const DECIMALS = 6;
const ONE_TOKEN = 1_000_000;

// The provider wallet is the authority of every test mint, so tests can mint
// tokens to any wallet. It also pays for the mints and token accounts that the
// helpers create.
const payer = (provider.wallet as anchor.Wallet).payer;

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

function profilePda(organizer: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("organizer"), organizer.toBuffer()],
    program.programId
  );
}

// The bounty ID is a u64 in the seeds: 8 bytes, little-endian.
function escrowPda(
  organizer: web3.PublicKey,
  bountyId: number
): [web3.PublicKey, number] {
  const idBytes = new BN(bountyId).toArrayLike(Buffer, "le", 8);
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), organizer.toBuffer(), idBytes],
    program.programId
  );
}

function vaultPda(escrow: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), escrow.toBuffer()],
    program.programId
  );
}

// The ID the program will give this organizer's next bounty: the counter in
// their profile, or 0 before their first bounty creates the profile.
async function nextBountyId(organizer: web3.PublicKey): Promise<number> {
  const [profile] = profilePda(organizer);
  const account = await program.account.organizerProfile.fetchNullable(profile);
  if (account === null) {
    return 0;
  }
  return account.nextBountyId.toNumber();
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

// A mint with no extensions. `tokenProgram` picks classic SPL Token or
// Token-2022.
async function createTestMint(
  tokenProgram: web3.PublicKey
): Promise<web3.PublicKey> {
  return createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    DECIMALS,
    web3.Keypair.generate(),
    CONFIRM,
    tokenProgram
  );
}

// Creates a Token-2022 mint carrying one extension. The extension's own
// initialize instruction has to run before the mint itself is initialized.
async function createMintWithExtension(
  mint: web3.Keypair,
  extension: ExtensionType,
  initializeExtension: web3.TransactionInstruction
): Promise<web3.PublicKey> {
  const space = getMintLen([extension]);
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  const tx = new web3.Transaction().add(
    web3.SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    initializeExtension,
    createInitializeMintInstruction(
      mint.publicKey,
      DECIMALS,
      payer.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID
    )
  );
  await provider.sendAndConfirm(tx, [mint], CONFIRM);
  return mint.publicKey;
}

// A mint that takes a 1% fee on every transfer.
async function createFeeMint(): Promise<web3.PublicKey> {
  const mint = web3.Keypair.generate();
  const initializeFee = createInitializeTransferFeeConfigInstruction(
    mint.publicKey,
    payer.publicKey,
    payer.publicKey,
    100,
    BigInt(1_000 * ONE_TOKEN),
    TOKEN_2022_PROGRAM_ID
  );
  return createMintWithExtension(
    mint,
    ExtensionType.TransferFeeConfig,
    initializeFee
  );
}

// A mint whose permanent delegate can move tokens out of any account.
async function createPermanentDelegateMint(): Promise<web3.PublicKey> {
  const mint = web3.Keypair.generate();
  const initializeDelegate = createInitializePermanentDelegateInstruction(
    mint.publicKey,
    payer.publicKey,
    TOKEN_2022_PROGRAM_ID
  );
  return createMintWithExtension(
    mint,
    ExtensionType.PermanentDelegate,
    initializeDelegate
  );
}

// A mint with the transfer hook extension but no hook program set yet. Its
// authority could still set one at any time.
async function createTransferHookMint(): Promise<web3.PublicKey> {
  const mint = web3.Keypair.generate();
  const initializeHook = createInitializeTransferHookInstruction(
    mint.publicKey,
    payer.publicKey,
    web3.PublicKey.default,
    TOKEN_2022_PROGRAM_ID
  );
  return createMintWithExtension(
    mint,
    ExtensionType.TransferHook,
    initializeHook
  );
}

// Gives `owner` an associated token account for `mint` holding `amount` base
// units. The provider wallet pays for the account and mints the tokens.
async function fundTokens(
  owner: web3.PublicKey,
  mint: web3.PublicKey,
  tokenProgram: web3.PublicKey,
  amount: number
): Promise<web3.PublicKey> {
  const account = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    owner,
    false,
    "confirmed",
    CONFIRM,
    tokenProgram
  );
  await mintTo(
    connection,
    payer,
    mint,
    account.address,
    payer,
    amount,
    [],
    CONFIRM,
    tokenProgram
  );
  return account.address;
}

// A token account's balance in base units. Works for both token programs.
async function tokenBalance(account: web3.PublicKey): Promise<number> {
  const balance = await connection.getTokenAccountBalance(account, "confirmed");
  return Number(balance.value.amount);
}

type BountyOptions = {
  mint: web3.PublicKey;
  judges: web3.PublicKey[];
  tokenProgram?: web3.PublicKey;
  title?: string;
  metadataUri?: string;
  metadataHash?: number[];
  threshold?: number;
  tierAmounts?: (number | BN)[];
  deadline?: number;
  claimDeadline?: number;
  bountyId?: number;
};

// Creates a bounty signed and paid for by `organizer`, funded from the
// organizer's associated token account for `mint`. Anything not given in
// `options` gets a valid default: a classic SPL mint, one 100-token tier,
// threshold 1, no metadata, voting closing in an hour and claiming closing
// exactly MIN_CLAIM_WINDOW after that. The bounty ID defaults to the one the
// program will assign; a test can pass another to build a stale request.
async function createBounty(organizer: web3.Keypair, options: BountyOptions) {
  const tokenProgram = options.tokenProgram ?? TOKEN_PROGRAM_ID;
  const title = options.title ?? "Test Bounty";
  const metadataUri = options.metadataUri ?? "";
  const metadataHash = options.metadataHash ?? Array(32).fill(0);
  const threshold = options.threshold ?? 1;
  const tierAmounts = options.tierAmounts ?? [100 * ONE_TOKEN];

  let deadline = options.deadline;
  if (deadline === undefined) {
    deadline = (await chainNow()) + ONE_HOUR;
  }

  let claimDeadline = options.claimDeadline;
  if (claimDeadline === undefined) {
    claimDeadline = deadline + MIN_CLAIM_WINDOW;
  }

  let bountyId = options.bountyId;
  if (bountyId === undefined) {
    bountyId = await nextBountyId(organizer.publicKey);
  }

  const [organizerProfile] = profilePda(organizer.publicKey);
  const [escrow] = escrowPda(organizer.publicKey, bountyId);
  const [vault] = vaultPda(escrow);
  const organizerTokenAccount = getAssociatedTokenAddressSync(
    options.mint,
    organizer.publicKey,
    false,
    tokenProgram
  );

  const amounts: BN[] = [];
  for (const amount of tierAmounts) {
    amounts.push(new BN(amount));
  }

  const signature = await programFor(organizer)
    .methods.initializeEscrow(
      title,
      metadataUri,
      metadataHash,
      options.judges,
      threshold,
      amounts,
      new BN(deadline),
      new BN(claimDeadline)
    )
    .accountsPartial({
      organizer: organizer.publicKey,
      organizerProfile,
      escrow,
      mint: options.mint,
      vault,
      organizerTokenAccount,
      tokenProgram,
    })
    .rpc();

  return { escrow, vault, bountyId, signature };
}

// ---------------------------------------------------------------------------
// initialize_escrow
// ---------------------------------------------------------------------------

describeLocal("initialize_escrow", () => {
  const organizer = web3.Keypair.generate();
  const judges = [
    web3.Keypair.generate().publicKey,
    web3.Keypair.generate().publicKey,
    web3.Keypair.generate().publicKey,
  ];

  // Signs every rejected request. Anchor creates the profile, escrow and
  // vault accounts before the handler runs its checks, so this wallet must
  // cover their rent (about 0.018 SOL locally) and fees. It holds a single
  // token, far less than the 100-token default prize, so a check that failed
  // to fire would surface as a token transfer error instead of the expected
  // program error.
  const underfundedOrganizer = web3.Keypair.generate();
  const UNDERFUNDED_LAMPORTS = 30_000_000;

  let mint: web3.PublicKey;
  let token2022Mint: web3.PublicKey;

  before(async () => {
    await fund(organizer.publicKey, web3.LAMPORTS_PER_SOL);
    await fund(underfundedOrganizer.publicKey, UNDERFUNDED_LAMPORTS);

    mint = await createTestMint(TOKEN_PROGRAM_ID);
    token2022Mint = await createTestMint(TOKEN_2022_PROGRAM_ID);
    await fundTokens(
      organizer.publicKey,
      mint,
      TOKEN_PROGRAM_ID,
      10_000 * ONE_TOKEN
    );
    await fundTokens(
      organizer.publicKey,
      token2022Mint,
      TOKEN_2022_PROGRAM_ID,
      10_000 * ONE_TOKEN
    );
    await fundTokens(
      underfundedOrganizer.publicKey,
      mint,
      TOKEN_PROGRAM_ID,
      ONE_TOKEN
    );
  });

  // None of the rejected requests may leave anything behind: the underfunded
  // organizer never gets a profile, and its first escrow address stays empty.
  async function expectCreateToFail(options: BountyOptions, code: string) {
    await expectError(createBounty(underfundedOrganizer, options), code);
    const [profile] = profilePda(underfundedOrganizer.publicKey);
    expect(await connection.getAccountInfo(profile)).to.equal(null);
    const [escrow] = escrowPda(underfundedOrganizer.publicKey, 0);
    expect(await connection.getAccountInfo(escrow)).to.equal(null);
  }

  it("creates a bounty and locks the prize pool", async () => {
    // 500 and 300 tokens
    const tierAmounts = [500 * ONE_TOKEN, 300 * ONE_TOKEN];
    const prizeTotal = 800 * ONE_TOKEN;
    const metadataHash: number[] = [];
    for (let i = 0; i < 32; i++) {
      metadataHash.push(i + 1);
    }
    const deadline = (await chainNow()) + ONE_HOUR;
    // Exactly the shortest claim window the program accepts.
    const claimDeadline = deadline + MIN_CLAIM_WINDOW;

    // This is the organizer's first bounty, so it has no profile yet.
    const [profile] = profilePda(organizer.publicKey);
    expect(await connection.getAccountInfo(profile)).to.equal(null);

    const source = getAssociatedTokenAddressSync(mint, organizer.publicKey);
    const tokensBefore = await tokenBalance(source);
    const lamportsBefore = await connection.getBalance(organizer.publicKey);

    const { escrow, vault, bountyId, signature } = await createBounty(
      organizer,
      {
        mint,
        judges,
        title: "Solana Summer Hackathon",
        metadataUri: "https://example.com/bounty.json",
        metadataHash,
        threshold: 2,
        tierAmounts,
        deadline,
        claimDeadline,
      }
    );

    // The first bounty gets ID 0, and the profile now hands out ID 1 next.
    expect(bountyId).to.equal(0);
    const profileAccount = await program.account.organizerProfile.fetch(
      profile
    );
    expect(profileAccount.nextBountyId.toNumber()).to.equal(1);

    const account = await program.account.escrow.fetch(escrow);
    const [, escrowBump] = escrowPda(organizer.publicKey, 0);
    const [, vaultBump] = vaultPda(escrow);

    expect(account.version).to.equal(2);
    expect(account.organizer.toBase58()).to.equal(
      organizer.publicKey.toBase58()
    );
    expect(account.bountyId.toNumber()).to.equal(0);
    expect(account.mint.toBase58()).to.equal(mint.toBase58());
    expect(account.deadline.toNumber()).to.equal(deadline);
    expect(account.claimDeadline.toNumber()).to.equal(claimDeadline);
    expect(account.threshold).to.equal(2);
    expect(account.bump).to.equal(escrowBump);
    expect(account.vaultBump).to.equal(vaultBump);
    expect(account.metadataHash).to.deep.equal(metadataHash);
    expect(account.title).to.equal("Solana Summer Hackathon");
    expect(account.metadataUri).to.equal("https://example.com/bounty.json");
    expect(account.judges.length).to.equal(judges.length);
    for (let i = 0; i < judges.length; i++) {
      expect(account.judges[i].toBase58()).to.equal(judges[i].toBase58());
    }

    expect(account.tiers.length).to.equal(tierAmounts.length);
    for (let i = 0; i < tierAmounts.length; i++) {
      const tier = account.tiers[i];
      expect(tier.amount.toNumber()).to.equal(tierAmounts[i]);
      expect(tier.claimed).to.equal(false);
      expect(tier.badgeMinted).to.equal(false);
      expect(tier.winner).to.equal(null);
      expect(tier.votes.length).to.equal(0);
    }

    // The vault is a token account for this mint, owned by the escrow, and
    // holds the whole prize pool, which left the organizer's token account.
    const vaultAccount = await getAccount(connection, vault, "confirmed");
    expect(vaultAccount.mint.toBase58()).to.equal(mint.toBase58());
    expect(vaultAccount.owner.toBase58()).to.equal(escrow.toBase58());
    expect(Number(vaultAccount.amount)).to.equal(prizeTotal);
    expect(tokensBefore - (await tokenBalance(source))).to.equal(prizeTotal);

    // In SOL, the organizer paid exactly the rent of the three new accounts
    // and the transaction fee.
    const profileRent = await connection.getBalance(profile);
    const escrowRent = await connection.getBalance(escrow);
    const vaultRent = await connection.getBalance(vault);
    const fee = await txFee(signature);
    const lamportsAfter = await connection.getBalance(organizer.publicKey);
    expect(lamportsBefore - lamportsAfter).to.equal(
      profileRent + escrowRent + vaultRent + fee
    );
  });

  it("gives each new bounty from the same wallet the next ID", async () => {
    const startId = await nextBountyId(organizer.publicKey);

    const first = await createBounty(organizer, {
      mint,
      judges,
      title: "First Bounty",
      tierAmounts: [100 * ONE_TOKEN],
    });

    const lamportsBefore = await connection.getBalance(organizer.publicKey);
    const second = await createBounty(organizer, {
      mint,
      judges,
      title: "Second Bounty",
      tierAmounts: [200 * ONE_TOKEN],
    });

    expect(first.bountyId).to.equal(startId);
    expect(second.bountyId).to.equal(startId + 1);
    expect(await nextBountyId(organizer.publicKey)).to.equal(startId + 2);
    expect(first.escrow.toBase58()).to.not.equal(second.escrow.toBase58());
    expect(first.vault.toBase58()).to.not.equal(second.vault.toBase58());

    const firstAccount = await program.account.escrow.fetch(first.escrow);
    expect(firstAccount.title).to.equal("First Bounty");
    expect(firstAccount.bountyId.toNumber()).to.equal(startId);

    const secondAccount = await program.account.escrow.fetch(second.escrow);
    expect(secondAccount.title).to.equal("Second Bounty");
    expect(secondAccount.bountyId.toNumber()).to.equal(startId + 1);

    // No metadata hash was given, which is stored as all zeros.
    expect(secondAccount.metadataHash).to.deep.equal(Array(32).fill(0));

    // Each vault holds only its own bounty's prize pool.
    expect(await tokenBalance(first.vault)).to.equal(100 * ONE_TOKEN);
    expect(await tokenBalance(second.vault)).to.equal(200 * ONE_TOKEN);

    // The profile already existed, so the second bounty cost only its own
    // escrow and vault rent and the fee.
    const escrowRent = await connection.getBalance(second.escrow);
    const vaultRent = await connection.getBalance(second.vault);
    const fee = await txFee(second.signature);
    const lamportsAfter = await connection.getBalance(organizer.publicKey);
    expect(lamportsBefore - lamportsAfter).to.equal(
      escrowRent + vaultRent + fee
    );
  });

  it("stores the escrow at the byte offsets clients filter on", async () => {
    const metadataHash: number[] = Array(32).fill(7);
    const { escrow, bountyId } = await createBounty(organizer, {
      mint,
      judges,
      metadataHash,
      threshold: 3,
    });
    const account = await program.account.escrow.fetch(escrow);

    const info = await connection.getAccountInfo(escrow);
    if (info === null) {
      throw new Error("Escrow account not found");
    }
    const data = info.data;

    expect(data.length).to.equal(1926);
    expect(data[8]).to.equal(2);
    expect(new web3.PublicKey(data.subarray(9, 41)).toBase58()).to.equal(
      organizer.publicKey.toBase58()
    );
    expect(Number(data.readBigUInt64LE(41))).to.equal(bountyId);
    expect(new web3.PublicKey(data.subarray(49, 81)).toBase58()).to.equal(
      mint.toBase58()
    );
    expect(Number(data.readBigInt64LE(81))).to.equal(
      account.deadline.toNumber()
    );
    expect(Number(data.readBigInt64LE(89))).to.equal(
      account.claimDeadline.toNumber()
    );
    expect(data[97]).to.equal(3);
    expect(data[98]).to.equal(account.bump);
    expect(data[99]).to.equal(account.vaultBump);
    expect(Array.from(data.subarray(100, 132))).to.deep.equal(metadataHash);

    // The judge count is at 132, and judge i sits at 136 + 32 * i.
    expect(data.readUInt32LE(132)).to.equal(judges.length);
    for (let i = 0; i < judges.length; i++) {
      const offset = 136 + 32 * i;
      const judge = new web3.PublicKey(data.subarray(offset, offset + 32));
      expect(judge.toBase58()).to.equal(judges[i].toBase58());
    }

    // The profile holds only its discriminator and the u64 counter.
    const [profile] = profilePda(organizer.publicKey);
    const profileInfo = await connection.getAccountInfo(profile);
    if (profileInfo === null) {
      throw new Error("Profile account not found");
    }
    expect(profileInfo.data.length).to.equal(16);
  });

  it("accepts a Token-2022 mint without extensions", async () => {
    const { escrow, vault } = await createBounty(organizer, {
      mint: token2022Mint,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      judges,
      tierAmounts: [250 * ONE_TOKEN],
    });

    const account = await program.account.escrow.fetch(escrow);
    expect(account.mint.toBase58()).to.equal(token2022Mint.toBase58());

    // The vault belongs to the Token-2022 program this time.
    const vaultInfo = await connection.getAccountInfo(vault);
    if (vaultInfo === null) {
      throw new Error("Vault account not found");
    }
    expect(vaultInfo.owner.toBase58()).to.equal(
      TOKEN_2022_PROGRAM_ID.toBase58()
    );
    const vaultAccount = await getAccount(
      connection,
      vault,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    expect(vaultAccount.mint.toBase58()).to.equal(token2022Mint.toBase58());
    expect(vaultAccount.owner.toBase58()).to.equal(escrow.toBase58());
    expect(Number(vaultAccount.amount)).to.equal(250 * ONE_TOKEN);
  });

  it("rejects a create built for a bounty ID that is already taken", async () => {
    // ID 0 was used by the first test, the way another device could get in
    // first with the same ID. The program derives the address from the
    // profile's counter instead, so the stale address fails the seeds check.
    const idBefore = await nextBountyId(organizer.publicKey);
    const [takenEscrow] = escrowPda(organizer.publicKey, 0);
    const [takenVault] = vaultPda(takenEscrow);
    const takenVaultBefore = await tokenBalance(takenVault);

    await expectError(
      createBounty(organizer, { mint, judges, bountyId: 0 }),
      "ConstraintSeeds"
    );

    // Nothing changed: the counter, the existing bounty and its vault.
    expect(await nextBountyId(organizer.publicKey)).to.equal(idBefore);
    const taken = await program.account.escrow.fetch(takenEscrow);
    expect(taken.title).to.equal("Solana Summer Hackathon");
    expect(await tokenBalance(takenVault)).to.equal(takenVaultBefore);
  });

  it("rejects an empty title", async () => {
    await expectCreateToFail({ mint, judges, title: "" }, "InvalidTitleLength");
  });

  it("rejects a 51-byte title", async () => {
    await expectCreateToFail(
      { mint, judges, title: "a".repeat(51) },
      "InvalidTitleLength"
    );
  });

  it("rejects a 101-byte metadata URI", async () => {
    await expectCreateToFail(
      { mint, judges, metadataUri: "a".repeat(101) },
      "InvalidMetadataUriLength"
    );
  });

  it("rejects an empty judges list", async () => {
    await expectCreateToFail({ mint, judges: [] }, "NoJudges");
  });

  it("rejects more than 5 judges", async () => {
    const sixJudges: web3.PublicKey[] = [];
    for (let i = 0; i < 6; i++) {
      sixJudges.push(web3.Keypair.generate().publicKey);
    }
    await expectCreateToFail({ mint, judges: sixJudges }, "TooManyJudges");
  });

  it("rejects an empty tier list", async () => {
    await expectCreateToFail({ mint, judges, tierAmounts: [] }, "NoTiers");
  });

  it("rejects more than 4 tiers", async () => {
    const fiveTiers = [ONE_TOKEN, ONE_TOKEN, ONE_TOKEN, ONE_TOKEN, ONE_TOKEN];
    await expectCreateToFail(
      { mint, judges, tierAmounts: fiveTiers },
      "TooManyTiers"
    );
  });

  it("rejects a threshold of zero", async () => {
    await expectCreateToFail(
      { mint, judges, threshold: 0 },
      "InvalidThreshold"
    );
  });

  it("rejects a threshold above the number of judges", async () => {
    await expectCreateToFail(
      { mint, judges, threshold: 4 },
      "InvalidThreshold"
    );
  });

  it("rejects the organizer as one of the judges", async () => {
    await expectCreateToFail(
      { mint, judges: [judges[0], underfundedOrganizer.publicKey] },
      "OrganizerCannotJudge"
    );
  });

  it("rejects a judge listed twice", async () => {
    await expectCreateToFail(
      { mint, judges: [judges[0], judges[1], judges[0]] },
      "DuplicateJudge"
    );
  });

  it("rejects a deadline in the past", async () => {
    const deadline = (await chainNow()) - 60;
    await expectCreateToFail({ mint, judges, deadline }, "InvalidDeadline");
  });

  it("rejects a claim window one second shorter than the minimum", async () => {
    const deadline = (await chainNow()) + ONE_HOUR;
    const claimDeadline = deadline + MIN_CLAIM_WINDOW - 1;
    await expectCreateToFail(
      { mint, judges, deadline, claimDeadline },
      "InvalidClaimDeadline"
    );
  });

  it("rejects a prize tier with a zero amount", async () => {
    await expectCreateToFail(
      { mint, judges, tierAmounts: [100 * ONE_TOKEN, 0] },
      "InvalidAmount"
    );
  });

  it("rejects prize amounts that overflow when added up", async () => {
    const maxU64 = new BN("18446744073709551615");
    await expectCreateToFail(
      { mint, judges, tierAmounts: [maxU64, 1] },
      "ArithmeticOverflow"
    );
  });

  it("rejects a Token-2022 mint that charges a transfer fee", async () => {
    const feeMint = await createFeeMint();
    await fundTokens(
      underfundedOrganizer.publicKey,
      feeMint,
      TOKEN_2022_PROGRAM_ID,
      ONE_TOKEN
    );
    await expectCreateToFail(
      { mint: feeMint, tokenProgram: TOKEN_2022_PROGRAM_ID, judges },
      "UnsupportedMint"
    );
  });

  it("rejects a Token-2022 mint with a permanent delegate", async () => {
    const delegateMint = await createPermanentDelegateMint();
    await fundTokens(
      underfundedOrganizer.publicKey,
      delegateMint,
      TOKEN_2022_PROGRAM_ID,
      ONE_TOKEN
    );
    await expectCreateToFail(
      { mint: delegateMint, tokenProgram: TOKEN_2022_PROGRAM_ID, judges },
      "UnsupportedMint"
    );
  });

  it("rejects a Token-2022 mint with a transfer hook", async () => {
    const hookMint = await createTransferHookMint();
    await fundTokens(
      underfundedOrganizer.publicKey,
      hookMint,
      TOKEN_2022_PROGRAM_ID,
      ONE_TOKEN
    );
    await expectCreateToFail(
      { mint: hookMint, tokenProgram: TOKEN_2022_PROGRAM_ID, judges },
      "UnsupportedMint"
    );
  });
});
