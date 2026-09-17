import { readFileSync } from "node:fs";
import { Chain, Common, Hardfork } from "@ethereumjs/common";
import { Account, Address, hexToBytes } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi, type Hex } from "viem";

interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

const disperserArtifact = load("TipDisperser");
const tokenArtifact = load("MockERC20");

function load(name: string): Artifact {
  return JSON.parse(readFileSync(`artifacts/${name}.json`, "utf8")) as Artifact;
}

function addressOf(hex: string): Address {
  return new Address(hexToBytes(hex as Hex));
}

const PAYER = addressOf("0x00000000000000000000000000000000000000f1");
const ALICE = addressOf("0x000000000000000000000000000000000000000a");
const BOB = addressOf("0x000000000000000000000000000000000000000b");
const GAS = 30_000_000n;

/** Runs the compiled bytecode in-process, so the batch semantics are executed, not assumed. */
class Evm {
  private constructor(private readonly vm: VM) {}

  static async create(): Promise<Evm> {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });
    const vm = await VM.create({ common });
    await vm.stateManager.putAccount(PAYER, new Account(0n, 10n ** 20n));
    return new Evm(vm);
  }

  async deploy(artifact: Artifact): Promise<Address> {
    const result = await this.vm.evm.runCall({
      caller: PAYER,
      origin: PAYER,
      gasLimit: GAS,
      data: hexToBytes(artifact.bytecode),
    });
    const created = result.createdAddress;
    if (!created) throw new Error(`deployment produced no address: ${result.execResult.exceptionError}`);
    return created;
  }

  async send(to: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<void> {
    const result = await this.vm.evm.runCall({
      caller: PAYER,
      origin: PAYER,
      to,
      gasLimit: GAS,
      data: hexToBytes(encodeFunctionData({ abi, functionName, args: args as never })),
    });
    if (result.execResult.exceptionError) {
      throw new Error(`${functionName} reverted: ${result.execResult.exceptionError.error}`);
    }
  }

  async call<T>(to: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<T> {
    const result = await this.vm.evm.runCall({
      caller: PAYER,
      origin: PAYER,
      to,
      gasLimit: GAS,
      data: hexToBytes(encodeFunctionData({ abi, functionName, args: args as never })),
    });
    if (result.execResult.exceptionError) {
      throw new Error(`${functionName} reverted: ${result.execResult.exceptionError.error}`);
    }
    return decodeFunctionResult({
      abi,
      functionName,
      data: `0x${Buffer.from(result.execResult.returnValue).toString("hex")}`,
    }) as T;
  }
}

describe("TipDisperser", () => {
  let evm: Evm;
  let disperser: Address;
  let token: Address;

  beforeAll(async () => {
    evm = await Evm.create();
    disperser = await evm.deploy(disperserArtifact);
    token = await evm.deploy(tokenArtifact);
  });

  async function fund(amount: bigint): Promise<void> {
    await evm.send(token, tokenArtifact.abi, "mint", [PAYER.toString(), amount]);
    await evm.send(token, tokenArtifact.abi, "approve", [disperser.toString(), amount]);
  }

  async function balance(account: Address): Promise<bigint> {
    return evm.call<bigint>(token, tokenArtifact.abi, "balanceOf", [account.toString()]);
  }

  it("pays every recipient in one transaction", async () => {
    const before = { alice: await balance(ALICE), bob: await balance(BOB) };
    await fund(7500n);

    await evm.send(disperser, disperserArtifact.abi, "disperseToken", [
      token.toString(),
      [ALICE.toString(), BOB.toString()],
      [5000n, 2500n],
    ]);

    expect(await balance(ALICE)).toBe(before.alice + 5000n);
    expect(await balance(BOB)).toBe(before.bob + 2500n);
  });

  it("reverts the whole batch when one leg is unpayable", async () => {
    const before = { alice: await balance(ALICE), bob: await balance(BOB) };
    await fund(1000n);

    await expect(
      evm.send(disperser, disperserArtifact.abi, "disperseToken", [
        token.toString(),
        [ALICE.toString(), BOB.toString()],
        [600n, 900n],
      ]),
    ).rejects.toThrow(/revert/i);

    // Atomicity is the point: a partial batch would settle Alice and silently
    // leave Bob owed, with the offchain ledger recording the epoch as settled.
    expect(await balance(ALICE)).toBe(before.alice);
    expect(await balance(BOB)).toBe(before.bob);
  });

  it("rejects mismatched recipient and value arrays", async () => {
    await fund(1000n);
    await expect(
      evm.send(disperser, disperserArtifact.abi, "disperseToken", [
        token.toString(),
        [ALICE.toString(), BOB.toString()],
        [100n],
      ]),
    ).rejects.toThrow(/revert/i);
  });

  it("rejects an empty batch", async () => {
    await expect(
      evm.send(disperser, disperserArtifact.abi, "disperseToken", [token.toString(), [], []]),
    ).rejects.toThrow(/revert/i);
  });
});
