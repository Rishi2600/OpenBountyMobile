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

// Funding for wallets that only sign and pay fees, such as judges. It covers
// the rent-exempt minimum a wallet must keep (about 0.0009 SOL) plus fees.
const FEE_LAMPORTS = 5_000_000;

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

// The shape of a JSON-RPC reply: `error` is set only when the call failed.
type RpcReply = {
  result?: unknown;
  error?: unknown;
};

// Sends one of Surfpool's cheatcode RPC methods. They exist only on a local
// Surfpool validator, and this refuses any other endpoint as well.
async function surfnetCheatcode(method: string, params: unknown[]) {
  if (!isLocalEndpoint(connection.rpcEndpoint)) {
    throw new Error("Cheatcodes only run against a local validator");
  }
  const response = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as RpcReply;
  if (body.error !== undefined) {
    throw new Error(method + " failed: " + JSON.stringify(body.error));
  }
  return body.result;
}

// Moves the local clock forward until it is strictly past `timestamp` (Unix
// seconds), so deadline tests do not wait in real time. Surfpool takes the
// target in milliseconds and refuses a target in the past. After the jump
// the clock keeps running from the new time.
async function advanceClockPast(timestamp: number) {
  if ((await chainNow()) > timestamp) {
    return;
  }
  const targetMilliseconds = (timestamp + 1) * 1000;
  await surfnetCheatcode("surfnet_timeTravel", [
    { absoluteTimestamp: targetMilliseconds },
  ]);
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await chainNow()) > timestamp) {
      return;
    }
    await sleep(500);
  }
  throw new Error("On-chain clock never passed " + timestamp);
}

// Overwrites one byte of an account's data on the local validator and leaves
// the rest of the account as it was.
async function overwriteAccountByte(
  address: web3.PublicKey,
  offset: number,
  value: number
) {
  const info = await connection.getAccountInfo(address);
  if (info === null) {
    throw new Error("Account not found: " + address.toBase58());
  }
  const data = Buffer.from(info.data);
  data[offset] = value;
  await surfnetCheatcode("surfnet_setAccount", [
    address.toBase58(),
    { data: data.toString("hex") },
  ]);
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
    return;
  }
  // A transaction sent raw, rather than through Anchor's .rpc(), fails with
  // web3's own error type. Its logs still carry Anchor's error line.
  if (caught instanceof web3.SendTransactionError) {
    let logs: string[] = [];
    if (caught.logs !== undefined) {
      logs = caught.logs;
    }
    const parsed = anchor.AnchorError.parse(logs);
    if (parsed !== null) {
      expect(parsed.error.errorCode.code).to.equal(code);
      return;
    }
  }
  expect(String(caught)).to.equal(code);
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

// Gives `owner` an empty associated token account for `mint`, paid for by the
// provider wallet.
async function createTokenAccount(
  owner: web3.PublicKey,
  mint: web3.PublicKey,
  tokenProgram: web3.PublicKey
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
  return account.address;
}

// Gives `owner` an associated token account for `mint` holding `amount` base
// units. The provider wallet pays for the account and mints the tokens.
async function fundTokens(
  owner: web3.PublicKey,
  mint: web3.PublicKey,
  tokenProgram: web3.PublicKey,
  amount: number
): Promise<web3.PublicKey> {
  const account = await createTokenAccount(owner, mint, tokenProgram);
  await mintTo(
    connection,
    payer,
    mint,
    account,
    payer,
    amount,
    [],
    CONFIRM,
    tokenProgram
  );
  return account;
}

// The token program that owns `mint`, read the way a client would read it.
async function tokenProgramOf(mint: web3.PublicKey): Promise<web3.PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (info === null) {
    throw new Error("Mint not found: " + mint.toBase58());
  }
  return info.owner;
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

// Casts one vote, signed and paid for by the judge.
async function castVote(
  judge: web3.Keypair,
  escrow: web3.PublicKey,
  tier: number,
  candidate: web3.PublicKey
) {
  return programFor(judge)
    .methods.voteWinner(tier, candidate)
    .accountsPartial({ escrow, judge: judge.publicKey })
    .rpc();
}

// Claims one tier, signed and paid for by `winner`. The mint, organizer and
// token program are read from the chain, the way a client would find them. A
// test can pass `organizer` to name someone else as the rent recipient.
async function claimPrize(
  winner: web3.Keypair,
  escrow: web3.PublicKey,
  tier: number,
  organizer?: web3.PublicKey
) {
  const account = await program.account.escrow.fetch(escrow);
  const tokenProgram = await tokenProgramOf(account.mint);

  let rentRecipient = account.organizer;
  if (organizer !== undefined) {
    rentRecipient = organizer;
  }

  const [vault] = vaultPda(escrow);
  const winnerTokenAccount = getAssociatedTokenAddressSync(
    account.mint,
    winner.publicKey,
    false,
    tokenProgram
  );

  return programFor(winner)
    .methods.claimPrize(tier)
    .accountsPartial({
      escrow,
      vault,
      mint: account.mint,
      winner: winner.publicKey,
      winnerTokenAccount,
      organizer: rentRecipient,
      tokenProgram,
    })
    .rpc();
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

// ---------------------------------------------------------------------------
// vote_winner
// ---------------------------------------------------------------------------

describeLocal("vote_winner", () => {
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

  let mint: web3.PublicKey;

  before(async () => {
    await fund(organizer.publicKey, web3.LAMPORTS_PER_SOL);
    for (const judge of judges) {
      await fund(judge.publicKey, FEE_LAMPORTS);
    }
    await fund(outsider.publicKey, FEE_LAMPORTS);

    mint = await createTestMint(TOKEN_PROGRAM_ID);
    await fundTokens(
      organizer.publicKey,
      mint,
      TOKEN_PROGRAM_ID,
      10_000 * ONE_TOKEN
    );
  });

  it("records a single vote without choosing a winner", async () => {
    const { escrow } = await createBounty(organizer, {
      mint,
      judges: judgeKeys,
      threshold: 2,
    });

    await castVote(judges[0], escrow, 0, candidateA);

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
    const { escrow, vault } = await createBounty(organizer, {
      mint,
      judges: judgeKeys,
      threshold: 2,
    });
    const vaultBefore = await tokenBalance(vault);

    await castVote(judges[0], escrow, 0, candidateA);
    let tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.winner).to.equal(null);

    await castVote(judges[1], escrow, 0, candidateA);
    tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(2);
    expect(tier.winner?.toBase58()).to.equal(candidateA.toBase58());
    expect(tier.claimed).to.equal(false);

    // Finalizing only records the winner. The prize stays in the vault until
    // the winner claims it.
    expect(await tokenBalance(vault)).to.equal(vaultBefore);
  });

  it("leaves the tier open when the votes are split", async () => {
    const { escrow } = await createBounty(organizer, {
      mint,
      judges: judgeKeys,
      threshold: 2,
    });

    await castVote(judges[0], escrow, 0, candidateA);
    await castVote(judges[1], escrow, 0, candidateB);
    await castVote(judges[2], escrow, 0, candidateC);

    // Every judge has voted and no candidate has two votes, so the tier can
    // never finalize.
    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(3);
    expect(tier.winner).to.equal(null);
  });

  it("finalizes two tiers independently", async () => {
    const { escrow } = await createBounty(organizer, {
      mint,
      judges: judgeKeys,
      threshold: 2,
      tierAmounts: [300 * ONE_TOKEN, 100 * ONE_TOKEN],
    });

    await castVote(judges[0], escrow, 0, candidateA);
    await castVote(judges[1], escrow, 0, candidateA);

    // Tier 0 is decided, and tier 1 has not been touched.
    let account = await program.account.escrow.fetch(escrow);
    expect(account.tiers[0].winner?.toBase58()).to.equal(candidateA.toBase58());
    expect(account.tiers[1].winner).to.equal(null);
    expect(account.tiers[1].votes.length).to.equal(0);

    // Judge 0 already voted on tier 0, and may still vote on tier 1.
    await castVote(judges[0], escrow, 1, candidateB);
    await castVote(judges[2], escrow, 1, candidateB);

    account = await program.account.escrow.fetch(escrow);
    expect(account.tiers[0].winner?.toBase58()).to.equal(candidateA.toBase58());
    expect(account.tiers[0].votes.length).to.equal(2);
    expect(account.tiers[1].winner?.toBase58()).to.equal(candidateB.toBase58());
    expect(account.tiers[1].votes.length).to.equal(2);
  });

  it("rejects a vote from someone who is not a judge", async () => {
    const { escrow } = await createBounty(organizer, {
      mint,
      judges: judgeKeys,
    });

    await expectError(castVote(outsider, escrow, 0, candidateA), "NotAJudge");

    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(0);
    expect(tier.winner).to.equal(null);
  });

  it("rejects a second vote from the same judge on the same tier", async () => {
    const { escrow } = await createBounty(organizer, {
      mint,
      judges: judgeKeys,
      threshold: 2,
    });

    await castVote(judges[0], escrow, 0, candidateA);
    await expectError(
      castVote(judges[0], escrow, 0, candidateA),
      "AlreadyVoted"
    );

    // Only the first vote counts, so candidate A is still one vote short.
    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(1);
    expect(tier.winner).to.equal(null);
  });

  it("rejects a vote on a tier that already has a winner", async () => {
    const { escrow } = await createBounty(organizer, {
      mint,
      judges: judgeKeys,
      threshold: 2,
    });

    await castVote(judges[0], escrow, 0, candidateA);
    await castVote(judges[1], escrow, 0, candidateA);
    await expectError(
      castVote(judges[2], escrow, 0, candidateB),
      "TierAlreadyFinalized"
    );

    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(2);
    expect(tier.winner?.toBase58()).to.equal(candidateA.toBase58());
  });

  it("rejects a vote on a tier that does not exist", async () => {
    const { escrow } = await createBounty(organizer, {
      mint,
      judges: judgeKeys,
    });

    // The bounty has a single tier, at index 0.
    await expectError(
      castVote(judges[0], escrow, 1, candidateA),
      "InvalidTierIndex"
    );

    const account = await program.account.escrow.fetch(escrow);
    expect(account.tiers.length).to.equal(1);
    expect(account.tiers[0].votes.length).to.equal(0);
  });

  it("rejects a vote after the deadline", async () => {
    // Far enough ahead for the creation transaction to land first. The test
    // then moves the clock past it instead of waiting.
    const deadline = (await chainNow()) + 60;
    const { escrow } = await createBounty(organizer, {
      mint,
      judges: judgeKeys,
      deadline,
    });

    await advanceClockPast(deadline);
    await expectError(
      castVote(judges[0], escrow, 0, candidateA),
      "DeadlinePassed"
    );

    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(0);
    expect(tier.winner).to.equal(null);
  });

  it("rejects an escrow written with a different layout version", async () => {
    const { escrow } = await createBounty(organizer, {
      mint,
      judges: judgeKeys,
    });

    // Pretend a future program version wrote this escrow by changing its
    // version byte, at offset 8, from 2 to 3.
    await overwriteAccountByte(escrow, 8, 3);
    const info = await connection.getAccountInfo(escrow);
    if (info === null) {
      throw new Error("Escrow account not found");
    }
    expect(info.data[8]).to.equal(3);
    expect(info.owner.toBase58()).to.equal(program.programId.toBase58());

    await expectError(
      castVote(judges[0], escrow, 0, candidateA),
      "UnsupportedEscrowVersion"
    );

    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.votes.length).to.equal(0);
    expect(tier.winner).to.equal(null);
  });
});

// ---------------------------------------------------------------------------
// claim_prize
// ---------------------------------------------------------------------------

describeLocal("claim_prize", () => {
  const organizer = web3.Keypair.generate();
  const judge = web3.Keypair.generate();
  const secondJudge = web3.Keypair.generate();
  const winner = web3.Keypair.generate();
  const outsider = web3.Keypair.generate();

  let mint: web3.PublicKey;
  let token2022Mint: web3.PublicKey;

  before(async () => {
    await fund(organizer.publicKey, web3.LAMPORTS_PER_SOL);
    await fund(judge.publicKey, FEE_LAMPORTS);
    await fund(secondJudge.publicKey, FEE_LAMPORTS);
    // Enough for fees and for the rent of the token account a claim creates.
    await fund(winner.publicKey, FEE_LAMPORTS);
    await fund(outsider.publicKey, FEE_LAMPORTS);

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
      1_000 * ONE_TOKEN
    );

    // The winner already has a token account for the classic mint, so most
    // tests here measure only the prize and the fee. The Token-2022 test and
    // one other test cover a claim that has to create the account.
    await createTokenAccount(winner.publicKey, mint, TOKEN_PROGRAM_ID);
  });

  // Two tiers of 300 and 100 tokens, decided by a single judge's vote.
  async function createTwoTierBounty() {
    return createBounty(organizer, {
      mint,
      judges: [judge.publicKey],
      threshold: 1,
      tierAmounts: [300 * ONE_TOKEN, 100 * ONE_TOKEN],
    });
  }

  it("pays the winner and marks the tier claimed", async () => {
    const { escrow, vault } = await createTwoTierBounty();
    await castVote(judge, escrow, 0, winner.publicKey);

    const winnerAccount = getAssociatedTokenAddressSync(mint, winner.publicKey);
    const winnerTokensBefore = await tokenBalance(winnerAccount);
    const vaultBefore = await tokenBalance(vault);
    const lamportsBefore = await connection.getBalance(winner.publicKey);

    const signature = await claimPrize(winner, escrow, 0);

    // The winner receives the full tier amount in tokens and, in SOL, pays
    // only their own fee.
    expect((await tokenBalance(winnerAccount)) - winnerTokensBefore).to.equal(
      300 * ONE_TOKEN
    );
    expect(vaultBefore - (await tokenBalance(vault))).to.equal(300 * ONE_TOKEN);
    const fee = await txFee(signature);
    const lamportsAfter = await connection.getBalance(winner.publicKey);
    expect(lamportsBefore - lamportsAfter).to.equal(fee);

    const account = await program.account.escrow.fetch(escrow);
    expect(account.tiers[0].claimed).to.equal(true);
    expect(account.tiers[1].claimed).to.equal(false);
  });

  it("rejects a claim from someone who is not the winner", async () => {
    const { escrow, vault } = await createTwoTierBounty();
    await castVote(judge, escrow, 0, winner.publicKey);
    const vaultBefore = await tokenBalance(vault);

    await expectError(claimPrize(outsider, escrow, 0), "NotWinner");

    expect(await tokenBalance(vault)).to.equal(vaultBefore);
    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.claimed).to.equal(false);
  });

  it("rejects a second claim of the same tier", async () => {
    const { escrow, vault } = await createTwoTierBounty();
    await castVote(judge, escrow, 0, winner.publicKey);
    await claimPrize(winner, escrow, 0);
    const vaultAfterFirstClaim = await tokenBalance(vault);

    await expectError(claimPrize(winner, escrow, 0), "TierAlreadyClaimed");

    expect(await tokenBalance(vault)).to.equal(vaultAfterFirstClaim);
  });

  it("rejects a claim before the tier has a winner", async () => {
    const { escrow, vault } = await createTwoTierBounty();
    const vaultBefore = await tokenBalance(vault);

    await expectError(claimPrize(winner, escrow, 0), "TierNotFinalized");

    expect(await tokenBalance(vault)).to.equal(vaultBefore);
    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.winner).to.equal(null);
    expect(tier.claimed).to.equal(false);
  });

  it("creates the token account of a winner who has none, at the winner's cost", async () => {
    const newWinner = web3.Keypair.generate();
    await fund(newWinner.publicKey, FEE_LAMPORTS);

    const { escrow } = await createTwoTierBounty();
    await castVote(judge, escrow, 0, newWinner.publicKey);

    const newWinnerAccount = getAssociatedTokenAddressSync(
      mint,
      newWinner.publicKey
    );
    expect(await connection.getAccountInfo(newWinnerAccount)).to.equal(null);
    const lamportsBefore = await connection.getBalance(newWinner.publicKey);

    const signature = await claimPrize(newWinner, escrow, 0);

    const created = await getAccount(connection, newWinnerAccount, "confirmed");
    expect(created.owner.toBase58()).to.equal(newWinner.publicKey.toBase58());
    expect(created.mint.toBase58()).to.equal(mint.toBase58());
    expect(Number(created.amount)).to.equal(300 * ONE_TOKEN);

    // The winner paid the fee and the new account's rent, nothing else.
    const accountRent = await connection.getBalance(newWinnerAccount);
    const fee = await txFee(signature);
    const lamportsAfter = await connection.getBalance(newWinner.publicKey);
    expect(lamportsBefore - lamportsAfter).to.equal(fee + accountRent);
  });

  it("rejects a claim that names someone else as the organizer", async () => {
    const { escrow, vault } = await createTwoTierBounty();
    await castVote(judge, escrow, 0, winner.publicKey);
    const vaultBefore = await tokenBalance(vault);

    // The organizer account only receives rent when the bounty closes. A
    // winner naming their own wallet here would collect that rent.
    await expectError(
      claimPrize(winner, escrow, 0, winner.publicKey),
      "Unauthorized"
    );

    expect(await tokenBalance(vault)).to.equal(vaultBefore);
    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.claimed).to.equal(false);
  });

  it("closes both accounts on the final claim and returns their rent to the organizer", async () => {
    const { escrow, vault } = await createTwoTierBounty();
    await castVote(judge, escrow, 0, winner.publicKey);
    await castVote(judge, escrow, 1, winner.publicKey);
    await claimPrize(winner, escrow, 0);

    // Before the final claim the vault holds only tier 1's prize.
    expect(await tokenBalance(vault)).to.equal(100 * ONE_TOKEN);
    const escrowRent = await connection.getBalance(escrow);
    const vaultRent = await connection.getBalance(vault);
    const organizerBefore = await connection.getBalance(organizer.publicKey);
    const winnerAccount = getAssociatedTokenAddressSync(mint, winner.publicKey);
    const winnerTokensBefore = await tokenBalance(winnerAccount);

    await claimPrize(winner, escrow, 1);

    expect(await connection.getAccountInfo(escrow)).to.equal(null);
    expect(await connection.getAccountInfo(vault)).to.equal(null);

    // The winner gets tier 1's prize. The organizer signed nothing, and
    // receives exactly the rent that kept both accounts alive.
    expect((await tokenBalance(winnerAccount)) - winnerTokensBefore).to.equal(
      100 * ONE_TOKEN
    );
    const organizerAfter = await connection.getBalance(organizer.publicKey);
    expect(organizerAfter - organizerBefore).to.equal(escrowRent + vaultRent);
  });

  it("pays tokens sent straight to the vault to the last claimer", async () => {
    const { escrow, vault } = await createBounty(organizer, {
      mint,
      judges: [judge.publicKey],
      tierAmounts: [100 * ONE_TOKEN],
    });
    await castVote(judge, escrow, 0, winner.publicKey);

    // Anyone can send tokens to a token account. 5 extra tokens arrive in the
    // vault that no tier accounts for.
    await mintTo(
      connection,
      payer,
      mint,
      vault,
      payer,
      5 * ONE_TOKEN,
      [],
      CONFIRM,
      TOKEN_PROGRAM_ID
    );
    expect(await tokenBalance(vault)).to.equal(105 * ONE_TOKEN);

    const winnerAccount = getAssociatedTokenAddressSync(mint, winner.publicKey);
    const winnerTokensBefore = await tokenBalance(winnerAccount);

    await claimPrize(winner, escrow, 0);

    // The final claim empties the vault, so the bounty can still close.
    expect((await tokenBalance(winnerAccount)) - winnerTokensBefore).to.equal(
      105 * ONE_TOKEN
    );
    expect(await connection.getAccountInfo(vault)).to.equal(null);
    expect(await connection.getAccountInfo(escrow)).to.equal(null);
  });

  it("pays a Token-2022 prize", async () => {
    const { escrow, vault } = await createBounty(organizer, {
      mint: token2022Mint,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      judges: [judge.publicKey],
      tierAmounts: [250 * ONE_TOKEN],
    });
    await castVote(judge, escrow, 0, winner.publicKey);

    await claimPrize(winner, escrow, 0);

    // The winner had no Token-2022 account for this mint, so the claim
    // created one under the Token-2022 program.
    const winnerAccount = getAssociatedTokenAddressSync(
      token2022Mint,
      winner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const info = await connection.getAccountInfo(winnerAccount);
    if (info === null) {
      throw new Error("Winner token account not found");
    }
    expect(info.owner.toBase58()).to.equal(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(await tokenBalance(winnerAccount)).to.equal(250 * ONE_TOKEN);

    // It was the only tier, so the bounty closed.
    expect(await connection.getAccountInfo(vault)).to.equal(null);
    expect(await connection.getAccountInfo(escrow)).to.equal(null);
  });

  it("rejects a claim after the claim deadline", async () => {
    const deadline = (await chainNow()) + 60;
    const claimDeadline = deadline + MIN_CLAIM_WINDOW;
    const { escrow, vault } = await createBounty(organizer, {
      mint,
      judges: [judge.publicKey],
      deadline,
      claimDeadline,
    });
    await castVote(judge, escrow, 0, winner.publicKey);
    const vaultBefore = await tokenBalance(vault);

    await advanceClockPast(claimDeadline);
    await expectError(claimPrize(winner, escrow, 0), "ClaimDeadlinePassed");

    expect(await tokenBalance(vault)).to.equal(vaultBefore);
    const tier = (await program.account.escrow.fetch(escrow)).tiers[0];
    expect(tier.claimed).to.equal(false);
  });

  // The v1 bug: escrow addresses were reused, so a vote signed for a closed
  // bounty landed on the next bounty at the same address. Bounty IDs are now
  // never reused, so the held vote can only ever reach the closed bounty.
  it("does not let a vote held back for a closed bounty touch the next bounty", async () => {
    const judges = [judge.publicKey, secondJudge.publicKey];
    const candidate = web3.Keypair.generate().publicKey;

    const closed = await createBounty(organizer, {
      mint,
      judges,
      threshold: 1,
    });

    // The first judge signs a vote for this bounty but does not send it.
    const heldVote = await programFor(judge)
      .methods.voteWinner(0, candidate)
      .accountsPartial({ escrow: closed.escrow, judge: judge.publicKey })
      .transaction();
    const latest = await connection.getLatestBlockhash("confirmed");
    heldVote.recentBlockhash = latest.blockhash;
    heldVote.feePayer = judge.publicKey;
    heldVote.sign(judge);

    // The second judge decides the tier, and the winner's claim closes it.
    await castVote(secondJudge, closed.escrow, 0, winner.publicKey);
    await claimPrize(winner, closed.escrow, 0);
    expect(await connection.getAccountInfo(closed.escrow)).to.equal(null);

    // The organizer's next bounty, with the same judges, gets a new address.
    const next = await createBounty(organizer, {
      mint,
      judges,
      threshold: 1,
    });
    expect(next.escrow.toBase58()).to.not.equal(closed.escrow.toBase58());

    // The held vote still targets the closed bounty, which no longer exists.
    await expectError(
      connection.sendRawTransaction(heldVote.serialize()),
      "AccountNotInitialized"
    );

    const tier = (await program.account.escrow.fetch(next.escrow)).tiers[0];
    expect(tier.votes.length).to.equal(0);
    expect(tier.winner).to.equal(null);
    expect(await connection.getAccountInfo(closed.escrow)).to.equal(null);
  });
});
