import { Chain, Common, Hardfork } from "@ethereumjs/common";
import { LegacyTransaction } from "@ethereumjs/tx";
import { Account, Address, hexToBytes } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Demonstrates the failure the firewall exists to prevent, by executing it.
 *
 * Two *different* transactions from one key, each assigned nonce 0 because
 * neither had landed when the other was built. This is what concurrent agents
 * sharing a treasury key produce: both submitters get a successful submission,
 * and exactly one transfer happens.
 */
const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ALICE: `0x${string}` = "0x000000000000000000000000000000000000000a";
const BOB: `0x${string}` = "0x000000000000000000000000000000000000000b";

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Berlin });

function signed(nonce: number, to: `0x${string}`, value: bigint) {
  return LegacyTransaction.fromTxData(
    { nonce: BigInt(nonce), gasPrice: 10n ** 9n, gasLimit: 100_000n, to, value },
    { common },
  ).sign(hexToBytes(PRIVATE_KEY));
}

async function freshVm(): Promise<{ vm: VM; sender: Address }> {
  const vm = await VM.create({ common });
  const sender = new Address(hexToBytes(privateKeyToAccount(PRIVATE_KEY).address));
  await vm.stateManager.putAccount(sender, new Account(0n, 10n ** 20n));
  return { vm, sender };
}

async function balance(vm: VM, address: `0x${string}`): Promise<bigint> {
  const account = await vm.stateManager.getAccount(new Address(hexToBytes(address)));
  return account?.balance ?? 0n;
}

describe("the failure being prevented", () => {
  it("drops one of two distinct transactions that share a nonce", async () => {
    const { vm } = await freshVm();

    await vm.runTx({ tx: signed(0, ALICE, 1000n), skipBalance: false });

    // Agent B built its transaction before agent A's landed, so it also read
    // nonce 0 as next. Nothing about it is malformed; it is simply too late.
    await expect(vm.runTx({ tx: signed(0, BOB, 2000n) })).rejects.toThrow(/nonce/i);

    expect(await balance(vm, ALICE)).toBe(1000n);
    expect(await balance(vm, BOB)).toBe(0n); // Bob's payment is gone, silently.
  });

  it("lands both when the same two transactions are serialized", async () => {
    const { vm } = await freshVm();

    await vm.runTx({ tx: signed(0, ALICE, 1000n) });
    await vm.runTx({ tx: signed(1, BOB, 2000n) });

    expect(await balance(vm, ALICE)).toBe(1000n);
    expect(await balance(vm, BOB)).toBe(2000n);
  });

  it("lets a higher-gas replacement evict an already-submitted transaction", async () => {
    const { vm } = await freshVm();

    // Same nonce, different destination, higher gas price: on a real node this
    // replaces the pending transaction rather than queueing behind it. The first
    // payee is not paid, and nobody is told.
    const replacement = LegacyTransaction.fromTxData(
      { nonce: 0n, gasPrice: 10n ** 10n, gasLimit: 100_000n, to: BOB, value: 2000n },
      { common },
    ).sign(hexToBytes(PRIVATE_KEY));

    await vm.runTx({ tx: replacement });

    expect(await balance(vm, BOB)).toBe(2000n);
    await expect(vm.runTx({ tx: signed(0, ALICE, 1000n) })).rejects.toThrow(/nonce/i);
    expect(await balance(vm, ALICE)).toBe(0n);
  });
});
