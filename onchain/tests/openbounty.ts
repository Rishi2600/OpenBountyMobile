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
