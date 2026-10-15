import * as anchor from "@anchor-lang/core";
import * as fs from "fs";
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

// ---------------------------------------------------------------------------
// submit_entry and close_entry
// ---------------------------------------------------------------------------

const SUBMISSION_SIZE = 531;

// Funding for a builder whose entry is expected to fail. Anchor creates the
// entry account before the handler's checks run, so the wallet needs its
// rent (about 0.0046 SOL) plus fees.
const ENTRY_RENT_AND_FEES = 6_000_000;

const BUILDER_LAMPORTS = web3.LAMPORTS_PER_SOL / 10;

type EntryFields = {
  title: string;
  url: string;
  description: string;
};

const DEFAULT_ENTRY: EntryFields = {
  title: "My project",
  url: "https://example.com/project",
  description: "What it does and how it was built.",
};

async function submitEntry(
  builder: web3.Keypair,
  escrow: web3.PublicKey,
  fields: EntryFields
): Promise<string> {
  const [submission] = submissionPda(escrow, builder.publicKey);
  return programFor(builder)
    .methods.submitEntry(fields.title, fields.url, fields.description)
    .accountsPartial({
      submitter: builder.publicKey,
      escrow,
      submission,
    })
    .rpc();
}

async function closeEntry(
  builder: web3.Keypair,
  submission: web3.PublicKey
): Promise<string> {
  return programFor(builder)
    .methods.closeEntry()
    .accountsPartial({
      submitter: builder.publicKey,
      submission,
    })
    .rpc();
}

describeLocal("submit_entry and close_entry", () => {
  let organizer: web3.Keypair;
  let judges: web3.Keypair[];
  let bounty: Bounty;
  let builder: web3.Keypair;

  before(async () => {
    organizer = await newFundedWallet(ORGANIZER_LAMPORTS);
    judges = [];
    for (let i = 0; i < 3; i++) {
      judges.push(await newFundedWallet(ENTRY_RENT_AND_FEES));
    }
    const judgeKeys: web3.PublicKey[] = [];
    for (const judge of judges) {
      judgeKeys.push(judge.publicKey);
    }
    bounty = await createBounty(organizer, { judges: judgeKeys });
    builder = await newFundedWallet(BUILDER_LAMPORTS);
  });

  it("records an entry, paid for by the builder", async () => {
    const before = await lamportsOf(builder.publicKey);
    const timeBefore = await chainNow();
    const signature = await submitEntry(builder, bounty.escrow, DEFAULT_ENTRY);
    const timeAfter = await chainNow();

    const [address, bump] = submissionPda(bounty.escrow, builder.publicKey);
    const entry = await program.account.submission.fetch(address);
    expect(entry.escrow.toBase58()).to.equal(bounty.escrow.toBase58());
    expect(entry.submitter.toBase58()).to.equal(builder.publicKey.toBase58());
    expect(entry.submittedAt.toNumber()).to.be.at.least(timeBefore);
    expect(entry.submittedAt.toNumber()).to.be.at.most(timeAfter);
    expect(entry.closeAfter.toNumber()).to.equal(bounty.params.deadline);
    expect(entry.bump).to.equal(bump);
    expect(entry.title).to.equal(DEFAULT_ENTRY.title);
    expect(entry.url).to.equal(DEFAULT_ENTRY.url);
    expect(entry.description).to.equal(DEFAULT_ENTRY.description);

    const info = await connection.getAccountInfo(address);
    expect(info?.data.length).to.equal(SUBMISSION_SIZE);
    const rent = await connection.getMinimumBalanceForRentExemption(
      SUBMISSION_SIZE
    );
    const fee = await txFee(signature);
    const after = await lamportsOf(builder.publicKey);
    expect(before - after).to.equal(rent + fee);
  });

  it("lists one bounty's entries with a single memcmp filter", async () => {
    const otherBuilder = await newFundedWallet(BUILDER_LAMPORTS);
    await submitEntry(otherBuilder, bounty.escrow, DEFAULT_ENTRY);

    // An entry on another bounty must not show up.
    const judgeKeys: web3.PublicKey[] = [];
    for (const judge of judges) {
      judgeKeys.push(judge.publicKey);
    }
    const otherBounty = await createBounty(organizer, { judges: judgeKeys });
    await submitEntry(builder, otherBounty.escrow, DEFAULT_ENTRY);

    const found = await connection.getProgramAccounts(program.programId, {
      commitment: "confirmed",
      filters: [
        { dataSize: SUBMISSION_SIZE },
        { memcmp: { offset: 8, bytes: bounty.escrow.toBase58() } },
      ],
    });
    const addresses: string[] = [];
    for (const account of found) {
      addresses.push(account.pubkey.toBase58());
    }
    addresses.sort();
    const expected = [
      submissionPda(bounty.escrow, builder.publicKey)[0].toBase58(),
      submissionPda(bounty.escrow, otherBuilder.publicKey)[0].toBase58(),
    ];
    expected.sort();
    expect(addresses).to.deep.equal(expected);
  });

  it("allows one entry per wallet per bounty", async () => {
    const [address] = submissionPda(bounty.escrow, builder.publicKey);
    const before = await program.account.submission.fetch(address);
    await expectFailureMentioning(
      submitEntry(builder, bounty.escrow, {
        title: "Second try",
        url: "https://example.com/other",
        description: "",
      }),
      "already in use"
    );
    const after = await program.account.submission.fetch(address);
    expect(after.title).to.equal(before.title);
  });

  it("rejects the organizer and the judges", async () => {
    await expectError(
      submitEntry(organizer, bounty.escrow, DEFAULT_ENTRY),
      "OrganizerCannotSubmit"
    );
    await expectError(
      submitEntry(judges[1], bounty.escrow, DEFAULT_ENTRY),
      "JudgeCannotSubmit"
    );
    const [organizerEntry] = submissionPda(bounty.escrow, organizer.publicKey);
    const [judgeEntry] = submissionPda(bounty.escrow, judges[1].publicKey);
    expect(await connection.getAccountInfo(organizerEntry)).to.equal(null);
    expect(await connection.getAccountInfo(judgeEntry)).to.equal(null);
  });

  it("checks the entry fields", async () => {
    // The longest name, link and description are accepted.
    const longest = await newFundedWallet(BUILDER_LAMPORTS);
    const fields: EntryFields = {
      title: "t".repeat(50),
      url: "u".repeat(100),
      description: "d".repeat(280),
    };
    await submitEntry(longest, bounty.escrow, fields);
    const [address] = submissionPda(bounty.escrow, longest.publicKey);
    const entry = await program.account.submission.fetch(address);
    expect(entry.title).to.equal(fields.title);
    expect(entry.url).to.equal(fields.url);
    expect(entry.description).to.equal(fields.description);

    // An empty description is accepted too.
    const brief = await newFundedWallet(BUILDER_LAMPORTS);
    await submitEntry(brief, bounty.escrow, {
      title: "Brief",
      url: "https://example.com",
      description: "",
    });

    const rejected = await newFundedWallet(ENTRY_RENT_AND_FEES);
    const cases: [EntryFields, string][] = [
      [{ ...DEFAULT_ENTRY, title: "" }, "InvalidEntryTitle"],
      [{ ...DEFAULT_ENTRY, title: "t".repeat(51) }, "InvalidEntryTitle"],
      [{ ...DEFAULT_ENTRY, url: "" }, "InvalidEntryUrl"],
      [{ ...DEFAULT_ENTRY, url: "u".repeat(101) }, "InvalidEntryUrl"],
      [
        { ...DEFAULT_ENTRY, description: "d".repeat(281) },
        "InvalidEntryDescription",
      ],
    ];
    for (const [badFields, code] of cases) {
      await expectError(submitEntry(rejected, bounty.escrow, badFields), code);
    }
    const [rejectedEntry] = submissionPda(bounty.escrow, rejected.publicKey);
    expect(await connection.getAccountInfo(rejectedEntry)).to.equal(null);
  });

  it("can't be closed before the deadline", async () => {
    const [address] = submissionPda(bounty.escrow, builder.publicKey);
    await expectError(closeEntry(builder, address), "EntryLocked");
    expect(await connection.getAccountInfo(address)).to.not.equal(null);
  });

  it("rejects entries once entries close, while judging goes on", async () => {
    await advanceClockPast(bounty.params.submissionsDeadline);
    expect(await chainNow()).to.be.at.most(bounty.params.deadline);

    const late = await newFundedWallet(ENTRY_RENT_AND_FEES);
    await expectError(
      submitEntry(late, bounty.escrow, DEFAULT_ENTRY),
      "SubmissionsClosed"
    );
    const [address] = submissionPda(bounty.escrow, late.publicKey);
    expect(await connection.getAccountInfo(address)).to.equal(null);

    // Still locked: judging has not ended.
    const [builderEntry] = submissionPda(bounty.escrow, builder.publicKey);
    await expectError(closeEntry(builder, builderEntry), "EntryLocked");
  });

  it("lets only the builder close their entry", async () => {
    await advanceClockPast(bounty.params.deadline);
    const [address] = submissionPda(bounty.escrow, builder.publicKey);
    const stranger = await newFundedWallet(FEE_LAMPORTS);

    // The entry's address is derived from its builder, so another signer
    // points at an address that does not hold this entry.
    await expectError(closeEntry(stranger, address), "ConstraintSeeds");
    expect(await connection.getAccountInfo(address)).to.not.equal(null);
  });

  it("returns the rent to the builder after the deadline", async () => {
    const [address] = submissionPda(bounty.escrow, builder.publicKey);
    const rent = await lamportsOf(address);
    const before = await lamportsOf(builder.publicKey);

    const signature = await closeEntry(builder, address);

    expect(await connection.getAccountInfo(address)).to.equal(null);
    const fee = await txFee(signature);
    const after = await lamportsOf(builder.publicKey);
    expect(after - before).to.equal(rent - fee);
  });
});

// ---------------------------------------------------------------------------
// vote_winner
// ---------------------------------------------------------------------------

async function voteWinner(
  judge: web3.Keypair,
  escrow: web3.PublicKey,
  tierIndex: number,
  candidate: web3.PublicKey
): Promise<string> {
  return programFor(judge)
    .methods.voteWinner(tierIndex, candidate)
    .accountsPartial({ judge: judge.publicKey, escrow })
    .rpc();
}

// Judges only sign and pay fees.
async function newJudges(count: number): Promise<web3.Keypair[]> {
  const judges: web3.Keypair[] = [];
  for (let i = 0; i < count; i++) {
    judges.push(await newFundedWallet(FEE_LAMPORTS));
  }
  return judges;
}

function publicKeysOf(wallets: web3.Keypair[]): web3.PublicKey[] {
  const keys: web3.PublicKey[] = [];
  for (const wallet of wallets) {
    keys.push(wallet.publicKey);
  }
  return keys;
}

async function fetchTier(escrow: web3.PublicKey, tierIndex: number) {
  const account = await program.account.escrow.fetch(escrow);
  return account.prizeTiers[tierIndex];
}

describeLocal("vote_winner", () => {
  let organizer: web3.Keypair;
  let judges: web3.Keypair[];
  // Three judges, so two matching votes decide a tier.
  let bounty: Bounty;
  let alice: web3.PublicKey;
  let bob: web3.PublicKey;

  before(async () => {
    organizer = await newFundedWallet(ORGANIZER_LAMPORTS);
    judges = await newJudges(3);
    bounty = await createBounty(organizer, { judges: publicKeysOf(judges) });
    alice = web3.Keypair.generate().publicKey;
    bob = web3.Keypair.generate().publicKey;
  });

  it("rejects the organizer and anyone who is not a judge", async () => {
    await expectError(
      voteWinner(organizer, bounty.escrow, 0, alice),
      "OrganizerCannotVote"
    );
    const stranger = await newFundedWallet(FEE_LAMPORTS);
    await expectError(
      voteWinner(stranger, bounty.escrow, 0, alice),
      "UnauthorizedJudge"
    );
    expect((await fetchTier(bounty.escrow, 0)).votes.length).to.equal(0);
  });

  it("rejects a tier that does not exist", async () => {
    await expectError(
      voteWinner(judges[0], bounty.escrow, 2, alice),
      "InvalidTier"
    );
  });

  it("rejects ineligible candidates", async () => {
    const ineligible = [
      organizer.publicKey,
      judges[0].publicKey,
      judges[2].publicKey,
      web3.PublicKey.default,
      bounty.escrow,
      bounty.vault,
    ];
    for (const candidate of ineligible) {
      await expectError(
        voteWinner(judges[0], bounty.escrow, 0, candidate),
        "InvalidCandidate"
      );
    }
    expect((await fetchTier(bounty.escrow, 0)).votes.length).to.equal(0);
  });

  it("records a vote without deciding the tier below the threshold", async () => {
    await voteWinner(judges[0], bounty.escrow, 0, alice);
    const tier = await fetchTier(bounty.escrow, 0);
    expect(tier.votes.length).to.equal(1);
    expect(tier.votes[0].judge.toBase58()).to.equal(
      judges[0].publicKey.toBase58()
    );
    expect(tier.votes[0].candidate.toBase58()).to.equal(alice.toBase58());
    expect(tier.winner).to.equal(null);
  });

  it("makes votes final: a judge can't vote twice on a tier", async () => {
    await expectError(
      voteWinner(judges[0], bounty.escrow, 0, bob),
      "DuplicateVote"
    );
    const tier = await fetchTier(bounty.escrow, 0);
    expect(tier.votes.length).to.equal(1);
    expect(tier.votes[0].candidate.toBase58()).to.equal(alice.toBase58());
  });

  it("decides the tier when a candidate reaches the threshold", async () => {
    await voteWinner(judges[1], bounty.escrow, 0, alice);
    const tier = await fetchTier(bounty.escrow, 0);
    expect(tier.votes.length).to.equal(2);
    expect(tier.winner?.toBase58()).to.equal(alice.toBase58());
    expect(tier.claimed).to.equal(false);
    // The other tier is untouched.
    expect((await fetchTier(bounty.escrow, 1)).votes.length).to.equal(0);
  });

  it("rejects votes on a decided tier", async () => {
    await expectError(
      voteWinner(judges[2], bounty.escrow, 0, bob),
      "TierAlreadyFinalized"
    );
    expect((await fetchTier(bounty.escrow, 0)).votes.length).to.equal(2);
  });

  it("leaves a tier undecided when the votes split", async () => {
    await voteWinner(judges[0], bounty.escrow, 1, alice);
    await voteWinner(judges[1], bounty.escrow, 1, bob);
    await voteWinner(
      judges[2],
      bounty.escrow,
      1,
      web3.Keypair.generate().publicKey
    );
    const tier = await fetchTier(bounty.escrow, 1);
    expect(tier.votes.length).to.equal(3);
    expect(tier.winner).to.equal(null);
  });

  it("lets one wallet win several tiers, with or without an entry", async () => {
    const other = await createBounty(organizer, {
      judges: publicKeysOf(judges),
    });
    // Carol never submitted an entry.
    const carol = web3.Keypair.generate().publicKey;
    for (const tierIndex of [0, 1]) {
      await voteWinner(judges[0], other.escrow, tierIndex, carol);
      await voteWinner(judges[2], other.escrow, tierIndex, carol);
    }
    expect((await fetchTier(other.escrow, 0)).winner?.toBase58()).to.equal(
      carol.toBase58()
    );
    expect((await fetchTier(other.escrow, 1)).winner?.toBase58()).to.equal(
      carol.toBase58()
    );
  });

  it("fills every vote slot of the largest bounty within its fixed size", async () => {
    const fiveJudges = await newJudges(5);
    const largest = await createBounty(organizer, {
      judges: publicKeysOf(fiveJudges),
      title: "t".repeat(50),
      metadataUri: "u".repeat(100),
      prizeAmounts: [
        new BN(MIN_PRIZE_AMOUNT),
        new BN(MIN_PRIZE_AMOUNT),
        new BN(MIN_PRIZE_AMOUNT),
        new BN(MIN_PRIZE_AMOUNT),
      ],
    });
    // Every judge names a different candidate, so no tier is decided and
    // every tier ends up with all five votes.
    for (let tierIndex = 0; tierIndex < 4; tierIndex++) {
      for (const judge of fiveJudges) {
        await voteWinner(
          judge,
          largest.escrow,
          tierIndex,
          web3.Keypair.generate().publicKey
        );
      }
    }
    const info = await connection.getAccountInfo(largest.escrow);
    expect(info?.data.length).to.equal(ESCROW_SIZE);
    const escrow = await program.account.escrow.fetch(largest.escrow);
    for (const tier of escrow.prizeTiers) {
      expect(tier.votes.length).to.equal(5);
      expect(tier.winner).to.equal(null);
    }
    expect(escrow.title).to.equal("t".repeat(50));
  });

  it("closes voting after the deadline", async () => {
    await advanceClockPast(bounty.params.deadline);
    // Tier 1 is still undecided, but the vote is too late.
    const late = await createBounty(organizer, {
      judges: publicKeysOf(judges),
    });
    await expectError(
      voteWinner(judges[0], bounty.escrow, 1, alice),
      "VotingClosed"
    );
    expect((await fetchTier(bounty.escrow, 1)).votes.length).to.equal(3);
    // A bounty whose deadline is still ahead keeps taking votes.
    await voteWinner(judges[0], late.escrow, 0, alice);
    expect((await fetchTier(late.escrow, 0)).votes.length).to.equal(1);
  });
});

// ---------------------------------------------------------------------------
// claim_prize and refund_unclaimed
// ---------------------------------------------------------------------------

// `organizer` is the account passed as the bounty's organizer, which a test
// can replace with a wrong one.
async function claimPrize(
  winner: web3.Keypair,
  bounty: Bounty,
  tierIndex: number,
  organizer: web3.PublicKey
): Promise<string> {
  return programFor(winner)
    .methods.claimPrize(tierIndex)
    .accountsPartial({
      winner: winner.publicKey,
      escrow: bounty.escrow,
      vault: bounty.vault,
      organizer,
    })
    .rpc();
}

async function refundInstruction(
  organizer: web3.Keypair,
  bounty: Bounty,
  tierIndex: number
): Promise<web3.TransactionInstruction> {
  return programFor(organizer)
    .methods.refundUnclaimed(tierIndex)
    .accountsPartial({
      organizer: organizer.publicKey,
      escrow: bounty.escrow,
      vault: bounty.vault,
    })
    .instruction();
}

async function refundUnclaimed(
  organizer: web3.Keypair,
  bounty: Bounty,
  tierIndex: number
): Promise<string> {
  return programFor(organizer)
    .methods.refundUnclaimed(tierIndex)
    .accountsPartial({
      organizer: organizer.publicKey,
      escrow: bounty.escrow,
      vault: bounty.vault,
    })
    .rpc();
}

// Sends several instructions in one transaction, paid for by `signer`.
async function sendInstructions(
  signer: web3.Keypair,
  instructions: web3.TransactionInstruction[]
): Promise<string> {
  const tx = new web3.Transaction();
  for (const instruction of instructions) {
    tx.add(instruction);
  }
  return providerFor(signer).sendAndConfirm(tx, [], CONFIRM);
}

// The two votes a three-judge bounty needs to decide a tier.
async function decideTier(
  judges: web3.Keypair[],
  bounty: Bounty,
  tierIndex: number,
  winner: web3.PublicKey
) {
  await voteWinner(judges[0], bounty.escrow, tierIndex, winner);
  await voteWinner(judges[1], bounty.escrow, tierIndex, winner);
}

describeLocal("claim_prize and refund_unclaimed", () => {
  let organizer: web3.Keypair;
  let judges: web3.Keypair[];
  let first: web3.Keypair;
  let second: web3.Keypair;
  let stranger: web3.Keypair;
  let builder: web3.Keypair;
  // Claimed in full before its deadline. Its vault was sent extra lamports
  // before creation.
  let early: Bounty;
  // Goes through every refund case: tier 0 is claimed after the deadline,
  // tier 1's winner never claims, tier 2 never gets a winner.
  let lifecycle: Bounty;
  // Never touched, then refunded in one transaction. Its vault was sent extra
  // lamports before creation.
  let untouched: Bounty;
  const prefunded = 2_000_000;

  // Pre-funds the vault of the organizer's next bounty, then creates it.
  async function createPrefundedBounty(options: BountyOptions) {
    const bountyId = await nextBountyId(organizer.publicKey);
    await fund(vaultPda(organizer.publicKey, bountyId)[0], prefunded);
    return createBounty(organizer, options);
  }

  before(async () => {
    organizer = await newFundedWallet(ORGANIZER_LAMPORTS);
    judges = await newJudges(3);
    first = await newFundedWallet(FEE_LAMPORTS);
    second = await newFundedWallet(FEE_LAMPORTS);
    stranger = await newFundedWallet(FEE_LAMPORTS);
    builder = await newFundedWallet(BUILDER_LAMPORTS);
    const judgeKeys = publicKeysOf(judges);

    early = await createPrefundedBounty({ judges: judgeKeys });
    lifecycle = await createBounty(organizer, {
      judges: judgeKeys,
      prizeAmounts: [
        new BN(7 * MIN_PRIZE_AMOUNT),
        new BN(5 * MIN_PRIZE_AMOUNT),
        new BN(3 * MIN_PRIZE_AMOUNT),
      ],
    });
    untouched = await createPrefundedBounty({
      judges: judgeKeys,
      prizeAmounts: [
        new BN(4 * MIN_PRIZE_AMOUNT),
        new BN(3 * MIN_PRIZE_AMOUNT),
        new BN(2 * MIN_PRIZE_AMOUNT),
        new BN(MIN_PRIZE_AMOUNT),
      ],
    });

    await submitEntry(builder, lifecycle.escrow, DEFAULT_ENTRY);
    await decideTier(judges, lifecycle, 0, first.publicKey);
    await decideTier(judges, lifecycle, 1, second.publicKey);
  });

  describe("before the deadline", () => {
    it("rejects a claim on an undecided tier or a tier that does not exist", async () => {
      await expectError(
        claimPrize(first, early, 0, organizer.publicKey),
        "TierNotFinalized"
      );
      await expectError(
        claimPrize(first, early, 2, organizer.publicKey),
        "InvalidTier"
      );
    });

    it("rejects anyone but the winner", async () => {
      await decideTier(judges, early, 0, first.publicKey);
      await expectError(
        claimPrize(stranger, early, 0, organizer.publicKey),
        "NotWinner"
      );
      expect((await fetchTier(early.escrow, 0)).claimed).to.equal(false);
    });

    it("rejects a wrong organizer account", async () => {
      await expectError(
        claimPrize(first, early, 0, stranger.publicKey),
        "OrganizerMismatch"
      );
    });

    it("pays the winner, before the deadline too", async () => {
      const amount = early.params.prizeAmounts[0].toNumber();
      const winnerBefore = await lamportsOf(first.publicKey);
      const vaultBefore = await lamportsOf(early.vault);

      const signature = await claimPrize(first, early, 0, organizer.publicKey);

      const fee = await txFee(signature);
      expect((await lamportsOf(first.publicKey)) - winnerBefore).to.equal(
        amount - fee
      );
      expect(vaultBefore - (await lamportsOf(early.vault))).to.equal(amount);
      const tier = await fetchTier(early.escrow, 0);
      expect(tier.claimed).to.equal(true);
      expect(tier.refunded).to.equal(false);
    });

    it("rejects a second claim", async () => {
      await expectError(
        claimPrize(first, early, 0, organizer.publicKey),
        "PrizeAlreadyClaimed"
      );
    });

    it("closes the bounty when the last tier is claimed, sweeping the vault to the organizer", async () => {
      await decideTier(judges, early, 1, second.publicKey);
      const amount = early.params.prizeAmounts[1].toNumber();
      const escrowRent = await lamportsOf(early.escrow);
      const organizerBefore = await lamportsOf(organizer.publicKey);
      const winnerBefore = await lamportsOf(second.publicKey);

      const signature = await claimPrize(second, early, 1, organizer.publicKey);

      const fee = await txFee(signature);
      expect((await lamportsOf(second.publicKey)) - winnerBefore).to.equal(
        amount - fee
      );
      // The organizer gets the escrow's rent and the lamports that were sent
      // to the vault before creation.
      expect(
        (await lamportsOf(organizer.publicKey)) - organizerBefore
      ).to.equal(escrowRent + prefunded);
      expect(await connection.getAccountInfo(early.escrow)).to.equal(null);
      expect(await lamportsOf(early.vault)).to.equal(0);
    });

    it("can't be blocked by the organizer handing their wallet to another program", async () => {
      const owner = await newFundedWallet(ORGANIZER_LAMPORTS);
      const bounty = await createBounty(owner, {
        judges: publicKeysOf(judges),
        prizeAmounts: [new BN(MIN_PRIZE_AMOUNT)],
      });
      await decideTier(judges, bounty, 0, first.publicKey);

      // The organizer reassigns their own wallet to some other program.
      const otherProgram = web3.Keypair.generate().publicKey;
      const assign = new web3.Transaction().add(
        web3.SystemProgram.assign({
          accountPubkey: owner.publicKey,
          programId: otherProgram,
        })
      );
      await providerFor(owner).sendAndConfirm(assign, [], CONFIRM);
      const ownerInfo = await connection.getAccountInfo(owner.publicKey);
      expect(ownerInfo?.owner.toBase58()).to.equal(otherProgram.toBase58());

      // The claim still goes through, and the escrow's rent is still credited
      // to the organizer's address.
      const escrowRent = await lamportsOf(bounty.escrow);
      const ownerBefore = await lamportsOf(owner.publicKey);
      await claimPrize(first, bounty, 0, owner.publicKey);
      expect(await connection.getAccountInfo(bounty.escrow)).to.equal(null);
      expect((await lamportsOf(owner.publicKey)) - ownerBefore).to.equal(
        escrowRent
      );
    });

    it("lets only the organizer refund", async () => {
      await expectError(
        refundUnclaimed(stranger, lifecycle, 2),
        "UnauthorizedOrganizer"
      );
    });

    it("never refunds before the deadline", async () => {
      await expectError(
        refundUnclaimed(organizer, lifecycle, 2),
        "DeadlineNotReached"
      );
      await expectError(
        refundUnclaimed(organizer, lifecycle, 1),
        "DeadlineNotReached"
      );
      expect((await fetchTier(lifecycle.escrow, 2)).refunded).to.equal(false);
    });
  });

  describe("after the deadline, inside the claim window", () => {
    before(async () => {
      await advanceClockPast(lifecycle.params.deadline);
      await advanceClockPast(untouched.params.deadline);
    });

    it("lets a winner still claim", async () => {
      const amount = lifecycle.params.prizeAmounts[0].toNumber();
      const before = await lamportsOf(first.publicKey);
      const signature = await claimPrize(
        first,
        lifecycle,
        0,
        organizer.publicKey
      );
      const fee = await txFee(signature);
      expect((await lamportsOf(first.publicKey)) - before).to.equal(
        amount - fee
      );
      expect((await fetchTier(lifecycle.escrow, 0)).claimed).to.equal(true);
    });

    it("refunds a tier that never got a winner", async () => {
      const amount = lifecycle.params.prizeAmounts[2].toNumber();
      const before = await lamportsOf(organizer.publicKey);
      const signature = await refundUnclaimed(organizer, lifecycle, 2);
      const fee = await txFee(signature);
      expect((await lamportsOf(organizer.publicKey)) - before).to.equal(
        amount - fee
      );
      const tier = await fetchTier(lifecycle.escrow, 2);
      expect(tier.refunded).to.equal(true);
      expect(tier.claimed).to.equal(false);
      // Tier 1 is still open, so the bounty stays.
      expect(await connection.getAccountInfo(lifecycle.escrow)).to.not.equal(
        null
      );
    });

    it("rejects refunding the same tier twice, or a claimed tier", async () => {
      await expectError(
        refundUnclaimed(organizer, lifecycle, 2),
        "RefundNotEligible"
      );
      await expectError(
        refundUnclaimed(organizer, lifecycle, 0),
        "RefundNotEligible"
      );
    });

    it("keeps an unclaimed winner's prize during the claim window", async () => {
      await expectError(
        refundUnclaimed(organizer, lifecycle, 1),
        "ClaimWindowOpen"
      );
      expect((await fetchTier(lifecycle.escrow, 1)).refunded).to.equal(false);
    });
  });

  describe("after the claim window", () => {
    before(async () => {
      const escrow = await program.account.escrow.fetch(lifecycle.escrow);
      await advanceClockPast(escrow.claimDeadline.toNumber());
      await advanceClockPast(untouched.params.deadline + MIN_CLAIM_WINDOW);
    });

    it("stops late claims", async () => {
      await expectError(
        claimPrize(second, lifecycle, 1, organizer.publicKey),
        "ClaimWindowClosed"
      );
      expect((await fetchTier(lifecycle.escrow, 1)).claimed).to.equal(false);
    });

    it("refunds the unclaimed winner's prize and closes the bounty", async () => {
      const amount = lifecycle.params.prizeAmounts[1].toNumber();
      const escrowRent = await lamportsOf(lifecycle.escrow);
      const before = await lamportsOf(organizer.publicKey);

      const signature = await refundUnclaimed(organizer, lifecycle, 1);

      const fee = await txFee(signature);
      expect((await lamportsOf(organizer.publicKey)) - before).to.equal(
        amount + escrowRent - fee
      );
      expect(await connection.getAccountInfo(lifecycle.escrow)).to.equal(null);
      expect(await lamportsOf(lifecycle.vault)).to.equal(0);
    });

    it("lets a builder close their entry after the bounty has closed", async () => {
      const [entry] = submissionPda(lifecycle.escrow, builder.publicKey);
      const rent = await lamportsOf(entry);
      const before = await lamportsOf(builder.publicKey);
      const signature = await closeEntry(builder, entry);
      const fee = await txFee(signature);
      expect(await connection.getAccountInfo(entry)).to.equal(null);
      expect((await lamportsOf(builder.publicKey)) - before).to.equal(
        rent - fee
      );
    });

    it("refunds every tier of an untouched bounty in one transaction", async () => {
      const prizePool = sumOf(untouched.params.prizeAmounts).toNumber();
      const escrowRent = await lamportsOf(untouched.escrow);
      const before = await lamportsOf(organizer.publicKey);

      const instructions: web3.TransactionInstruction[] = [];
      for (let tierIndex = 0; tierIndex < 4; tierIndex++) {
        instructions.push(
          await refundInstruction(organizer, untouched, tierIndex)
        );
      }
      const signature = await sendInstructions(organizer, instructions);

      // Every prize, the escrow's rent and the lamports sent to the vault
      // before creation all go back to the organizer.
      const fee = await txFee(signature);
      expect((await lamportsOf(organizer.publicKey)) - before).to.equal(
        prizePool + prefunded + escrowRent - fee
      );
      expect(await connection.getAccountInfo(untouched.escrow)).to.equal(null);
      expect(await lamportsOf(untouched.vault)).to.equal(0);
    });
  });
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

// Finds the one event with this name in a transaction's events.
function eventNamed(events: anchor.Event[], name: string): anchor.Event {
  for (const event of events) {
    if (event.name === name) {
      return event;
    }
  }
  throw new Error("No " + name + " event in " + eventNames(events).join(", "));
}

function expectKey(actual: web3.PublicKey, expected: web3.PublicKey) {
  expect(actual.toBase58()).to.equal(expected.toBase58());
}

describeLocal("events", () => {
  let organizer: web3.Keypair;
  let judges: web3.Keypair[];
  let winner: web3.Keypair;
  let builder: web3.Keypair;
  // Tier 0 is claimed, tier 1's winner never claims, tier 2 never gets a
  // winner.
  let bounty: Bounty;

  before(async () => {
    organizer = await newFundedWallet(ORGANIZER_LAMPORTS);
    judges = await newJudges(3);
    winner = await newFundedWallet(FEE_LAMPORTS);
    builder = await newFundedWallet(BUILDER_LAMPORTS);
  });

  it("emits EscrowInitialized on create", async () => {
    bounty = await createBounty(organizer, {
      judges: publicKeysOf(judges),
      prizeAmounts: [
        new BN(3 * MIN_PRIZE_AMOUNT),
        new BN(2 * MIN_PRIZE_AMOUNT),
        new BN(MIN_PRIZE_AMOUNT),
      ],
    });
    const events = await eventsOf(bounty.signature);
    expect(eventNames(events)).to.deep.equal(["escrowInitialized"]);
    const data = events[0].data;
    expectKey(data.escrow, bounty.escrow);
    expectKey(data.organizer, organizer.publicKey);
    expect(data.bountyId.toNumber()).to.equal(bounty.bountyId);
    expect(data.prizePool.toNumber()).to.equal(6 * MIN_PRIZE_AMOUNT);
    expect(data.submissionsDeadline.toNumber()).to.equal(
      bounty.params.submissionsDeadline
    );
    expect(data.deadline.toNumber()).to.equal(bounty.params.deadline);
    expect(data.claimDeadline.toNumber()).to.equal(
      bounty.params.deadline + MIN_CLAIM_WINDOW
    );
  });

  it("emits EntrySubmitted on submit_entry", async () => {
    const signature = await submitEntry(builder, bounty.escrow, DEFAULT_ENTRY);
    const events = await eventsOf(signature);
    expect(eventNames(events)).to.deep.equal(["entrySubmitted"]);
    const data = events[0].data;
    expectKey(data.escrow, bounty.escrow);
    expectKey(
      data.submission,
      submissionPda(bounty.escrow, builder.publicKey)[0]
    );
    expectKey(data.submitter, builder.publicKey);
  });

  it("emits VoteCast for a vote below the threshold", async () => {
    const signature = await voteWinner(
      judges[0],
      bounty.escrow,
      0,
      winner.publicKey
    );
    const events = await eventsOf(signature);
    expect(eventNames(events)).to.deep.equal(["voteCast"]);
    const data = events[0].data;
    expectKey(data.escrow, bounty.escrow);
    expect(data.tierIndex).to.equal(0);
    expectKey(data.judge, judges[0].publicKey);
    expectKey(data.candidate, winner.publicKey);
  });

  it("emits VoteCast then TierFinalized for the deciding vote", async () => {
    const signature = await voteWinner(
      judges[1],
      bounty.escrow,
      0,
      winner.publicKey
    );
    const events = await eventsOf(signature);
    expect(eventNames(events)).to.deep.equal(["voteCast", "tierFinalized"]);
    expectKey(events[0].data.judge, judges[1].publicKey);
    const data = eventNamed(events, "tierFinalized").data;
    expectKey(data.escrow, bounty.escrow);
    expect(data.tierIndex).to.equal(0);
    expectKey(data.winner, winner.publicKey);
  });

  it("emits PrizeClaimed alone while other tiers are open", async () => {
    const signature = await claimPrize(winner, bounty, 0, organizer.publicKey);
    const events = await eventsOf(signature);
    expect(eventNames(events)).to.deep.equal(["prizeClaimed"]);
    const data = events[0].data;
    expectKey(data.escrow, bounty.escrow);
    expect(data.tierIndex).to.equal(0);
    expectKey(data.winner, winner.publicKey);
    expect(data.amount.toNumber()).to.equal(3 * MIN_PRIZE_AMOUNT);
  });

  it("emits PrizeClaimed then EscrowClosed for the claim that settles a bounty", async () => {
    const single = await createBounty(organizer, {
      judges: publicKeysOf(judges),
      prizeAmounts: [new BN(MIN_PRIZE_AMOUNT)],
    });
    await decideTier(judges, single, 0, winner.publicKey);
    const signature = await claimPrize(winner, single, 0, organizer.publicKey);
    const events = await eventsOf(signature);
    expect(eventNames(events)).to.deep.equal(["prizeClaimed", "escrowClosed"]);
    expectKey(eventNamed(events, "escrowClosed").data.escrow, single.escrow);
  });

  it("emits TierRefunded alone while other tiers are open", async () => {
    await decideTier(judges, bounty, 1, winner.publicKey);
    await advanceClockPast(bounty.params.deadline);
    const signature = await refundUnclaimed(organizer, bounty, 2);
    const events = await eventsOf(signature);
    expect(eventNames(events)).to.deep.equal(["tierRefunded"]);
    const data = events[0].data;
    expectKey(data.escrow, bounty.escrow);
    expect(data.tierIndex).to.equal(2);
    expect(data.amount.toNumber()).to.equal(MIN_PRIZE_AMOUNT);
  });

  it("emits TierRefunded then EscrowClosed for the refund that settles a bounty", async () => {
    await advanceClockPast(bounty.params.deadline + MIN_CLAIM_WINDOW);
    const signature = await refundUnclaimed(organizer, bounty, 1);
    const events = await eventsOf(signature);
    expect(eventNames(events)).to.deep.equal(["tierRefunded", "escrowClosed"]);
    expect(eventNamed(events, "tierRefunded").data.amount.toNumber()).to.equal(
      2 * MIN_PRIZE_AMOUNT
    );
    expectKey(eventNamed(events, "escrowClosed").data.escrow, bounty.escrow);
  });

  it("emits EntryClosed on close_entry", async () => {
    const [entry] = submissionPda(bounty.escrow, builder.publicKey);
    const signature = await closeEntry(builder, entry);
    const events = await eventsOf(signature);
    expect(eventNames(events)).to.deep.equal(["entryClosed"]);
    const data = events[0].data;
    expectKey(data.escrow, bounty.escrow);
    expectKey(data.submission, entry);
    expectKey(data.submitter, builder.publicKey);
  });
});

// ---------------------------------------------------------------------------
// IDL
// ---------------------------------------------------------------------------

describeLocal("IDL", () => {
  it("is committed in idl/ exactly as the build produced it", () => {
    // The mobile app generates its client from the committed copy, so a stale
    // copy would give the app the wrong interface.
    const committed = fs.readFileSync("idl/openbounty.json", "utf8");
    const built = fs.readFileSync("target/idl/openbounty.json", "utf8");
    expect(committed).to.equal(built);
  });

  it("exposes the six instructions", () => {
    const names: string[] = [];
    for (const instruction of program.idl.instructions) {
      names.push(instruction.name);
    }
    names.sort();
    expect(names).to.deep.equal([
      "claimPrize",
      "closeEntry",
      "initializeEscrow",
      "refundUnclaimed",
      "submitEntry",
      "voteWinner",
    ]);
  });
});
