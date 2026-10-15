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
const ONE_DAY = 24 * ONE_HOUR;

// Funding for wallets that only sign and pay fees, such as judges. It covers
// the rent-exempt minimum a wallet must keep (about 0.0009 SOL) plus fees.
const FEE_LAMPORTS = 5_000_000;

// Must match the program's constants.
const MIN_PRIZE_AMOUNT = 1_000_000;
const MIN_CLAIM_WINDOW = ONE_DAY;
const MAX_CLAIM_WINDOW = 90 * ONE_DAY;
const MAX_DEADLINE_AHEAD = 365 * ONE_DAY;

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

// A provider where `signer` signs and pays the fee, the same way each user
// pays for their own transactions in the mobile app.
function providerFor(signer: web3.Keypair): anchor.AnchorProvider {
  return new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(signer),
    CONFIRM
  );
}

// A client for the program that sends as `signer`.
function programFor(signer: web3.Keypair): Program<Openbounty> {
  return new Program<Openbounty>(program.idl, providerFor(signer));
}

function profilePda(organizer: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("organizer"), organizer.toBuffer()],
    program.programId
  );
}

// The bounty ID is a u64 in the seeds: 8 bytes, little-endian.
function bountyIdBytes(bountyId: number): Buffer {
  return new BN(bountyId).toArrayLike(Buffer, "le", 8);
}

function escrowPda(
  organizer: web3.PublicKey,
  bountyId: number
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), organizer.toBuffer(), bountyIdBytes(bountyId)],
    program.programId
  );
}

function vaultPda(
  organizer: web3.PublicKey,
  bountyId: number
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), organizer.toBuffer(), bountyIdBytes(bountyId)],
    program.programId
  );
}

function submissionPda(
  escrow: web3.PublicKey,
  submitter: web3.PublicKey
): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("submission"), escrow.toBuffer(), submitter.toBuffer()],
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

// A public RPC node (such as devnet's) can take a moment to serve a
// transaction it has just confirmed, so this retries briefly before failing.
async function fetchTransactionMeta(
  signature: string
): Promise<web3.ConfirmedTransactionMeta> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx !== null && tx.meta !== null) {
      return tx.meta;
    }
    await sleep(500);
  }
  throw new Error("Transaction not found: " + signature);
}

async function txFee(signature: string): Promise<number> {
  const meta = await fetchTransactionMeta(signature);
  return meta.fee;
}

// The events a transaction emitted, in order, decoded from its logs. Each
// has the event's `name` and its fields in `data`.
async function eventsOf(signature: string): Promise<anchor.Event[]> {
  const meta = await fetchTransactionMeta(signature);
  let logs: string[] = [];
  if (meta.logMessages !== null && meta.logMessages !== undefined) {
    logs = meta.logMessages;
  }
  const parser = new anchor.EventParser(program.programId, program.coder);
  const events: anchor.Event[] = [];
  for (const event of parser.parseLogs(logs)) {
    events.push(event);
  }
  return events;
}

// The names of a transaction's events, in order. Anchor's TypeScript client
// reports them in camelCase ("escrowInitialized"), while the IDL and the Rust
// code name them in PascalCase ("EscrowInitialized").
function eventNames(events: anchor.Event[]): string[] {
  const names: string[] = [];
  for (const event of events) {
    names.push(event.name);
  }
  return names;
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

// Asserts that `action` fails with the named program error, for example
// "InvalidTitle". On a mismatch the raw error is shown.
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

// Funding for an organizer whose create is expected to fail. Anchor creates
// the profile and escrow accounts before the handler's checks run, so the
// wallet needs their rent (about 0.015 SOL) plus fees, but never enough for
// a prize pool. A check that wrongly passed would then fail on funding
// instead of succeeding.
const RENT_AND_FEES = 16_000_000;

// Funding for an organizer that creates many bounties in one describe block.
const ORGANIZER_LAMPORTS = 20 * web3.LAMPORTS_PER_SOL;

const ESCROW_SIZE = 1877;
const PROFILE_SIZE = 16;

const U64_MAX = new BN("18446744073709551615");

async function newFundedWallet(lamports: number): Promise<web3.Keypair> {
  const wallet = web3.Keypair.generate();
  await fund(wallet.publicKey, lamports);
  return wallet;
}

// Judges only need addresses until they vote.
function newAddresses(count: number): web3.PublicKey[] {
  const addresses: web3.PublicKey[] = [];
  for (let i = 0; i < count; i++) {
    addresses.push(web3.Keypair.generate().publicKey);
  }
  return addresses;
}

// The smallest strict majority of `judgeCount` judges.
function majorityOf(judgeCount: number): number {
  return Math.floor(judgeCount / 2) + 1;
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

async function lamportsOf(address: web3.PublicKey): Promise<number> {
  return connection.getBalance(address, "confirmed");
}

function sumOf(amounts: BN[]): BN {
  let total = new BN(0);
  for (const amount of amounts) {
    total = total.add(amount);
  }
  return total;
}

// Everything initialize_escrow takes. Times are Unix seconds.
type BountyParams = {
  title: string;
  metadataUri: string;
  judges: web3.PublicKey[];
  voteThreshold: number;
  prizeAmounts: BN[];
  submissionsDeadline: number;
  deadline: number;
  claimWindow: number;
};

// Any field left out gets a working default.
type BountyOptions = {
  judges: web3.PublicKey[];
  title?: string;
  metadataUri?: string;
  voteThreshold?: number;
  prizeAmounts?: BN[];
  submissionsDeadline?: number;
  deadline?: number;
  claimWindow?: number;
};

type Bounty = {
  bountyId: number;
  escrow: web3.PublicKey;
  vault: web3.PublicKey;
  params: BountyParams;
  signature: string;
};

// By default entries close in one hour, judging ends in two, and winners
// get the shortest claim window.
async function bountyParams(options: BountyOptions): Promise<BountyParams> {
  const now = await chainNow();
  const params: BountyParams = {
    title: "Test bounty",
    metadataUri: "https://example.com/bounty.json",
    judges: options.judges,
    voteThreshold: majorityOf(options.judges.length),
    prizeAmounts: [new BN(5 * MIN_PRIZE_AMOUNT), new BN(3 * MIN_PRIZE_AMOUNT)],
    submissionsDeadline: now + ONE_HOUR,
    deadline: now + 2 * ONE_HOUR,
    claimWindow: MIN_CLAIM_WINDOW,
  };
  if (options.title !== undefined) {
    params.title = options.title;
  }
  if (options.metadataUri !== undefined) {
    params.metadataUri = options.metadataUri;
  }
  if (options.voteThreshold !== undefined) {
    params.voteThreshold = options.voteThreshold;
  }
  if (options.prizeAmounts !== undefined) {
    params.prizeAmounts = options.prizeAmounts;
  }
  if (options.submissionsDeadline !== undefined) {
    params.submissionsDeadline = options.submissionsDeadline;
  }
  if (options.deadline !== undefined) {
    params.deadline = options.deadline;
  }
  if (options.claimWindow !== undefined) {
    params.claimWindow = options.claimWindow;
  }
  return params;
}

// Sends initialize_escrow with explicit escrow and vault addresses, so a test
// can also pass wrong ones.
async function sendInitializeEscrow(
  organizer: web3.Keypair,
  params: BountyParams,
  escrow: web3.PublicKey,
  vault: web3.PublicKey
): Promise<string> {
  const [profile] = profilePda(organizer.publicKey);
  return programFor(organizer)
    .methods.initializeEscrow({
      title: params.title,
      metadataUri: params.metadataUri,
      judges: params.judges,
      voteThreshold: params.voteThreshold,
      prizeAmounts: params.prizeAmounts,
      submissionsDeadline: new BN(params.submissionsDeadline),
      deadline: new BN(params.deadline),
      claimWindow: new BN(params.claimWindow),
    })
    .accountsPartial({
      organizer: organizer.publicKey,
      organizerProfile: profile,
      escrow,
      vault,
    })
    .rpc();
}

// Creates a bounty at the organizer's next bounty ID.
async function createBounty(
  organizer: web3.Keypair,
  options: BountyOptions
): Promise<Bounty> {
  const params = await bountyParams(options);
  const bountyId = await nextBountyId(organizer.publicKey);
  const [escrow] = escrowPda(organizer.publicKey, bountyId);
  const [vault] = vaultPda(organizer.publicKey, bountyId);
  const signature = await sendInitializeEscrow(
    organizer,
    params,
    escrow,
    vault
  );
  return { bountyId, escrow, vault, params, signature };
}

// The error text plus any program logs, for failures that are not one of the
// program's own errors (such as the System Program refusing a transfer).
function errorText(err: unknown): string {
  let text = String(err);
  if (err instanceof web3.SendTransactionError && err.logs !== undefined) {
    text = text + "\n" + err.logs.join("\n");
  }
  if (err instanceof anchor.AnchorError) {
    text = text + "\n" + err.logs.join("\n");
  }
  if (err instanceof anchor.ProgramError && err.logs !== undefined) {
    text = text + "\n" + err.logs.join("\n");
  }
  return text;
}

async function expectFailureMentioning(action: Promise<unknown>, text: string) {
  let caught: unknown = null;
  try {
    await action;
  } catch (err) {
    caught = err;
  }
  if (caught === null) {
    expect.fail("Expected the transaction to fail mentioning " + text);
  }
  expect(errorText(caught)).to.include(text);
}

// ---------------------------------------------------------------------------
// initialize_escrow
// ---------------------------------------------------------------------------

describeLocal("initialize_escrow", () => {
  let organizer: web3.Keypair;
  // Sends every create that is expected to fail.
  let lowFunds: web3.Keypair;
  let judges: web3.PublicKey[];

  before(async () => {
    organizer = await newFundedWallet(ORGANIZER_LAMPORTS);
    lowFunds = await newFundedWallet(RENT_AND_FEES);
    judges = newAddresses(3);
  });

  // Asserts that a failed create left nothing behind: no profile and no
  // bounty for the low-funds organizer, whose counter therefore stays at 0.
  async function expectNothingCreated() {
    const [profile] = profilePda(lowFunds.publicKey);
    const [escrow] = escrowPda(lowFunds.publicKey, 0);
    expect(await connection.getAccountInfo(profile)).to.equal(null);
    expect(await connection.getAccountInfo(escrow)).to.equal(null);
  }

  it("creates the escrow and funds the whole prize pool atomically", async () => {
    const before = await lamportsOf(organizer.publicKey);
    const timeBefore = await chainNow();
    const bounty = await createBounty(organizer, { judges });
    const timeAfter = await chainNow();
    const prizePool = sumOf(bounty.params.prizeAmounts);

    expect(bounty.bountyId).to.equal(0);
    const [, escrowBump] = escrowPda(organizer.publicKey, 0);
    const [, vaultBump] = vaultPda(organizer.publicKey, 0);

    const escrow = await program.account.escrow.fetch(bounty.escrow);
    expect(escrow.organizer.toBase58()).to.equal(
      organizer.publicKey.toBase58()
    );
    expect(escrow.bountyId.toNumber()).to.equal(0);
    expect(escrow.bump).to.equal(escrowBump);
    expect(escrow.vaultBump).to.equal(vaultBump);
    expect(escrow.voteThreshold).to.equal(2);
    expect(escrow.createdAt.toNumber()).to.be.at.least(timeBefore);
    expect(escrow.createdAt.toNumber()).to.be.at.most(timeAfter);
    expect(escrow.submissionsDeadline.toNumber()).to.equal(
      bounty.params.submissionsDeadline
    );
    expect(escrow.deadline.toNumber()).to.equal(bounty.params.deadline);
    expect(escrow.claimDeadline.toNumber()).to.equal(
      bounty.params.deadline + MIN_CLAIM_WINDOW
    );
    expect(escrow.title).to.equal("Test bounty");
    expect(escrow.metadataUri).to.equal("https://example.com/bounty.json");
    expect(escrow.judges.length).to.equal(3);
    for (let i = 0; i < 3; i++) {
      expect(escrow.judges[i].toBase58()).to.equal(judges[i].toBase58());
    }
    expect(escrow.prizeTiers.length).to.equal(2);
    for (let i = 0; i < 2; i++) {
      const tier = escrow.prizeTiers[i];
      expect(tier.amount.toString()).to.equal(
        bounty.params.prizeAmounts[i].toString()
      );
      expect(tier.winner).to.equal(null);
      expect(tier.claimed).to.equal(false);
      expect(tier.refunded).to.equal(false);
      expect(tier.votes.length).to.equal(0);
    }

    // The vault holds exactly the prize pool.
    expect(await lamportsOf(bounty.vault)).to.equal(prizePool.toNumber());

    const profile = await program.account.organizerProfile.fetch(
      profilePda(organizer.publicKey)[0]
    );
    expect(profile.nextBountyId.toNumber()).to.equal(1);

    // The organizer paid the prize pool, both accounts' rent and the fee.
    const escrowInfo = await connection.getAccountInfo(bounty.escrow);
    expect(escrowInfo?.data.length).to.equal(ESCROW_SIZE);
    const escrowRent = await connection.getMinimumBalanceForRentExemption(
      ESCROW_SIZE
    );
    const profileRent = await connection.getMinimumBalanceForRentExemption(
      PROFILE_SIZE
    );
    const fee = await txFee(bounty.signature);
    const after = await lamportsOf(organizer.publicKey);
    expect(before - after).to.equal(
      prizePool.toNumber() + escrowRent + profileRent + fee
    );
  });

  it("gives each new bounty the next ID and a new address", async () => {
    const before = await lamportsOf(organizer.publicKey);
    const first = escrowPda(organizer.publicKey, 0)[0];
    const bounty = await createBounty(organizer, { judges });

    expect(bounty.bountyId).to.equal(1);
    expect(bounty.escrow.toBase58()).to.not.equal(first.toBase58());
    const escrow = await program.account.escrow.fetch(bounty.escrow);
    expect(escrow.bountyId.toNumber()).to.equal(1);
    expect(await nextBountyId(organizer.publicKey)).to.equal(2);

    // The profile already exists, so only the escrow's rent is paid.
    const escrowRent = await connection.getMinimumBalanceForRentExemption(
      ESCROW_SIZE
    );
    const fee = await txFee(bounty.signature);
    const prizePool = sumOf(bounty.params.prizeAmounts).toNumber();
    const after = await lamportsOf(organizer.publicKey);
    expect(before - after).to.equal(prizePool + escrowRent + fee);
  });

  it("rejects the address of an ID that is already used", async () => {
    const params = await bountyParams({ judges });
    const [usedEscrow] = escrowPda(organizer.publicKey, 0);
    const [usedVault] = vaultPda(organizer.publicKey, 0);
    const counterBefore = await nextBountyId(organizer.publicKey);

    await expectError(
      sendInitializeEscrow(organizer, params, usedEscrow, usedVault),
      "ConstraintSeeds"
    );
    expect(await nextBountyId(organizer.publicKey)).to.equal(counterBefore);
  });

  // Sends a create from the low-funds organizer, at its next address.
  async function createWithLowFunds(options: BountyOptions) {
    const params = await bountyParams(options);
    const [escrow] = escrowPda(lowFunds.publicKey, 0);
    const [vault] = vaultPda(lowFunds.publicKey, 0);
    return sendInitializeEscrow(lowFunds, params, escrow, vault);
  }

  it("accepts a 50-byte title and rejects an empty or longer one", async () => {
    const bounty = await createBounty(organizer, {
      judges,
      title: "a".repeat(50),
    });
    const escrow = await program.account.escrow.fetch(bounty.escrow);
    expect(escrow.title).to.equal("a".repeat(50));

    await expectError(
      createWithLowFunds({ judges, title: "" }),
      "InvalidTitle"
    );
    await expectError(
      createWithLowFunds({ judges, title: "a".repeat(51) }),
      "InvalidTitle"
    );
    // The limit is in bytes: 26 two-byte characters are 52 bytes.
    await expectError(
      createWithLowFunds({ judges, title: "é".repeat(26) }),
      "InvalidTitle"
    );
    await expectNothingCreated();
  });

  it("accepts an empty or 100-byte metadata URI and rejects a longer one", async () => {
    const empty = await createBounty(organizer, { judges, metadataUri: "" });
    expect(
      (await program.account.escrow.fetch(empty.escrow)).metadataUri
    ).to.equal("");
    const longest = await createBounty(organizer, {
      judges,
      metadataUri: "u".repeat(100),
    });
    expect(
      (await program.account.escrow.fetch(longest.escrow)).metadataUri
    ).to.equal("u".repeat(100));

    await expectError(
      createWithLowFunds({ judges, metadataUri: "u".repeat(101) }),
      "InvalidMetadataUri"
    );
    await expectNothingCreated();
  });

  it("checks the judge list", async () => {
    const five = newAddresses(5);
    const bounty = await createBounty(organizer, { judges: five });
    const escrow = await program.account.escrow.fetch(bounty.escrow);
    expect(escrow.judges.length).to.equal(5);
    expect(escrow.voteThreshold).to.equal(3);

    await expectError(
      createWithLowFunds({ judges: [], voteThreshold: 0 }),
      "InvalidJudgeCount"
    );
    await expectError(
      createWithLowFunds({ judges: newAddresses(6) }),
      "InvalidJudgeCount"
    );
    await expectError(
      createWithLowFunds({ judges: [judges[0], judges[1], judges[0]] }),
      "DuplicateJudge"
    );
    await expectError(
      createWithLowFunds({
        judges: [judges[0], lowFunds.publicKey, judges[1]],
      }),
      "OrganizerCannotBeJudge"
    );
    await expectNothingCreated();
  });

  it("requires a strict-majority vote threshold", async () => {
    // With 3 judges, 2 and 3 are majorities.
    for (const threshold of [2, 3]) {
      const bounty = await createBounty(organizer, {
        judges,
        voteThreshold: threshold,
      });
      const escrow = await program.account.escrow.fetch(bounty.escrow);
      expect(escrow.voteThreshold).to.equal(threshold);
    }

    // 0 and 1 of 3 are not majorities, and 4 is more than the judges.
    for (const threshold of [0, 1, 4]) {
      await expectError(
        createWithLowFunds({ judges, voteThreshold: threshold }),
        "InvalidVoteThreshold"
      );
    }
    // Half is not a majority: 2 of 4.
    await expectError(
      createWithLowFunds({ judges: newAddresses(4), voteThreshold: 2 }),
      "InvalidVoteThreshold"
    );
    await expectNothingCreated();
  });

  it("checks the prize tiers, the minimum prize and overflow", async () => {
    const four = [
      new BN(MIN_PRIZE_AMOUNT),
      new BN(MIN_PRIZE_AMOUNT),
      new BN(MIN_PRIZE_AMOUNT),
      new BN(MIN_PRIZE_AMOUNT),
    ];
    const bounty = await createBounty(organizer, {
      judges,
      prizeAmounts: four,
    });
    const escrow = await program.account.escrow.fetch(bounty.escrow);
    expect(escrow.prizeTiers.length).to.equal(4);
    expect(await lamportsOf(bounty.vault)).to.equal(4 * MIN_PRIZE_AMOUNT);

    await expectError(
      createWithLowFunds({ judges, prizeAmounts: [] }),
      "InvalidPrizeTierCount"
    );
    const five = [...four, new BN(MIN_PRIZE_AMOUNT)];
    await expectError(
      createWithLowFunds({ judges, prizeAmounts: five }),
      "InvalidPrizeTierCount"
    );
    await expectError(
      createWithLowFunds({
        judges,
        prizeAmounts: [new BN(MIN_PRIZE_AMOUNT), new BN(MIN_PRIZE_AMOUNT - 1)],
      }),
      "InvalidPrizeAmount"
    );
    await expectError(
      createWithLowFunds({
        judges,
        prizeAmounts: [U64_MAX, new BN(MIN_PRIZE_AMOUNT)],
      }),
      "PrizePoolOverflow"
    );
    await expectNothingCreated();
  });

  it("checks the deadline: in the future and at most 365 days away", async () => {
    const now = await chainNow();
    // A margin of ten minutes keeps the boundary cases clear of the time the
    // transaction takes to land.
    const latest = now + MAX_DEADLINE_AHEAD - 600;
    const bounty = await createBounty(organizer, { judges, deadline: latest });
    const escrow = await program.account.escrow.fetch(bounty.escrow);
    expect(escrow.deadline.toNumber()).to.equal(latest);

    await expectError(
      createWithLowFunds({
        judges,
        submissionsDeadline: now - 10,
        deadline: now - 10,
      }),
      "InvalidDeadline"
    );
    await expectError(
      createWithLowFunds({ judges, deadline: now + MAX_DEADLINE_AHEAD + 600 }),
      "InvalidDeadline"
    );
    await expectNothingCreated();
  });

  it("checks the entry deadline: in the future and not after the deadline", async () => {
    const now = await chainNow();
    const deadline = now + 2 * ONE_HOUR;
    // Entries may stay open until judging ends.
    const bounty = await createBounty(organizer, {
      judges,
      submissionsDeadline: deadline,
      deadline,
    });
    const escrow = await program.account.escrow.fetch(bounty.escrow);
    expect(escrow.submissionsDeadline.toNumber()).to.equal(deadline);

    await expectError(
      createWithLowFunds({ judges, submissionsDeadline: now - 10, deadline }),
      "InvalidSubmissionsDeadline"
    );
    await expectError(
      createWithLowFunds({
        judges,
        submissionsDeadline: deadline + 1,
        deadline,
      }),
      "InvalidSubmissionsDeadline"
    );
    await expectNothingCreated();
  });

  it("checks the claim window: 1 to 90 days", async () => {
    for (const window of [MIN_CLAIM_WINDOW, MAX_CLAIM_WINDOW]) {
      const bounty = await createBounty(organizer, {
        judges,
        claimWindow: window,
      });
      const escrow = await program.account.escrow.fetch(bounty.escrow);
      expect(escrow.claimDeadline.toNumber()).to.equal(
        bounty.params.deadline + window
      );
    }

    await expectError(
      createWithLowFunds({ judges, claimWindow: MIN_CLAIM_WINDOW - 1 }),
      "InvalidClaimWindow"
    );
    await expectError(
      createWithLowFunds({ judges, claimWindow: MAX_CLAIM_WINDOW + 1 }),
      "InvalidClaimWindow"
    );
    await expectNothingCreated();
  });

  it("fails as a whole when the organizer can't pay the prize pool", async () => {
    const before = await lamportsOf(lowFunds.publicKey);
    await expectFailureMentioning(
      createWithLowFunds({
        judges,
        prizeAmounts: [new BN(web3.LAMPORTS_PER_SOL)],
      }),
      "insufficient lamports"
    );
    await expectNothingCreated();
    const [vault] = vaultPda(lowFunds.publicKey, 0);
    expect(await lamportsOf(vault)).to.equal(0);
    expect(await lamportsOf(lowFunds.publicKey)).to.equal(before);
  });

  it("tolerates lamports sent to the vault before creation", async () => {
    const bountyId = await nextBountyId(organizer.publicKey);
    const [vault] = vaultPda(organizer.publicKey, bountyId);
    const prefunded = 2_000_000;
    await fund(vault, prefunded);

    const bounty = await createBounty(organizer, { judges });
    expect(bounty.vault.toBase58()).to.equal(vault.toBase58());
    const prizePool = sumOf(bounty.params.prizeAmounts).toNumber();
    expect(await lamportsOf(vault)).to.equal(prefunded + prizePool);
    const escrow = await program.account.escrow.fetch(bounty.escrow);
    expect(escrow.bountyId.toNumber()).to.equal(bountyId);
  });

  it("fits the largest bounty in the fixed-size account", async () => {
    const bounty = await createBounty(organizer, {
      judges: newAddresses(5),
      title: "t".repeat(50),
      metadataUri: "u".repeat(100),
      prizeAmounts: [
        new BN(MIN_PRIZE_AMOUNT),
        new BN(MIN_PRIZE_AMOUNT),
        new BN(MIN_PRIZE_AMOUNT),
        new BN(MIN_PRIZE_AMOUNT),
      ],
    });
    const info = await connection.getAccountInfo(bounty.escrow);
    expect(info?.data.length).to.equal(ESCROW_SIZE);
    const escrow = await program.account.escrow.fetch(bounty.escrow);
    expect(escrow.judges.length).to.equal(5);
    expect(escrow.prizeTiers.length).to.equal(4);
  });
});
