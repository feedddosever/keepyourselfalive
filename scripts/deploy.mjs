import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const { DEPLOYER_PRIVATE_KEY, RPC_URL = "https://sepolia.base.org", CONTRACT = "TipDisperser" } = process.env;
if (!DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY is not set");

const artifact = JSON.parse(readFileSync(`artifacts/${CONTRACT}.json`, "utf8"));
const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
const transport = http(RPC_URL);
const wallet = createWalletClient({ account, chain: baseSepolia, transport });
const publicClient = createPublicClient({ chain: baseSepolia, transport });

const balance = await publicClient.getBalance({ address: account.address });
if (balance === 0n) {
  throw new Error(`${account.address} has no Base Sepolia ETH; fund it before deploying`);
}

console.log(`deploying ${CONTRACT} from ${account.address}`);
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
console.log(`tx  ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`deployment reverted: ${hash}`);

console.log(`${CONTRACT} deployed at ${receipt.contractAddress}`);
console.log(`https://sepolia.basescan.org/address/${receipt.contractAddress}`);
